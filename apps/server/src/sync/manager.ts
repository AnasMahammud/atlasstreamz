import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { nextSyncAt } from '@atlas/core';
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { listProviders, type ProviderRow } from '../providers.ts';
import { log } from '../log.ts';
import type { SyncSummary } from './import.ts';

export interface SyncState {
  running: null | { providerId: string; runId: number; stage: string; detail?: string; startedAt: number; trigger: string };
  queue: string[];
  last: Record<string, { ok: boolean; finishedAt: number; summary?: SyncSummary; error?: string }>;
}

/**
 * Schedules provider refreshes: every 24 h after a success, exponential backoff after
 * failures, one provider at a time. If the machine slept through a scheduled time, the next
 * check (every few minutes, and at start-up) catches up — we don't promise exact timing.
 */
export class SyncManager extends EventEmitter {
  state: SyncState = { running: null, queue: [], last: {} };
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DB) {
    super();
  }

  start(): void {
    // Runs left "in progress" by a crash are marked failed.
    this.db.prepare(`UPDATE sync_runs SET finished_at = ?, ok = 0, error = 'Interrupted' WHERE finished_at IS NULL`).run(Date.now());
    setTimeout(() => this.checkDue(), 3_000);
    this.timer = setInterval(() => this.checkDue(), 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  nextRunAt(row: ProviderRow): number | null {
    if (!row.enabled || !row.auto_sync || (row.is_https === 0 && row.http_consent === 0)) return null;
    return nextSyncAt({
      lastSuccessAt: row.last_success_at ?? undefined,
      lastAttemptAt: row.last_attempt_at ?? undefined,
      consecutiveFailures: row.consecutive_failures,
      intervalMs: config.syncIntervalMs,
      now: Date.now(),
    });
  }

  checkDue(): void {
    const now = Date.now();
    for (const row of listProviders(this.db)) {
      const due = this.nextRunAt(row);
      if (due !== null && due <= now) this.enqueue(row.id, 'scheduled');
    }
  }

  enqueue(providerId: string, trigger: 'manual' | 'scheduled' | 'setup'): boolean {
    if (this.state.running?.providerId === providerId || this.state.queue.includes(providerId)) return false;
    this.state.queue.push(providerId);
    this.pump(trigger);
    return true;
  }

  private pump(trigger: string): void {
    if (this.state.running) return;
    const providerId = this.state.queue.shift();
    if (!providerId) return;
    const startedAt = Date.now();
    const runId = Number(
      this.db.prepare('INSERT INTO sync_runs (provider_id, started_at, trigger) VALUES (?, ?, ?)').run(providerId, startedAt, trigger).lastInsertRowid,
    );
    this.db.prepare('UPDATE providers SET last_attempt_at = ? WHERE id = ?').run(startedAt, providerId);
    this.state.running = { providerId, runId, stage: 'starting', startedAt, trigger };
    this.emit('change', this.state);
    log.info(`Sync ${runId} started for ${providerId} (${trigger})`);

    const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { providerId, runId }, execArgv: ['--import', 'tsx'] });
    let settled = false;
    const finish = (ok: boolean, summary?: SyncSummary, error?: string) => {
      if (settled) return;
      settled = true;
      const finishedAt = Date.now();
      this.db
        .prepare('UPDATE sync_runs SET finished_at = ?, ok = ?, summary_json = ?, error = ? WHERE id = ?')
        .run(finishedAt, ok ? 1 : 0, summary ? JSON.stringify(summary) : null, error ?? null, runId);
      if (ok) {
        this.db.prepare('UPDATE providers SET last_success_at = ?, consecutive_failures = 0, last_error = NULL WHERE id = ?').run(finishedAt, providerId);
        log.info(`Sync ${runId} finished in ${Math.round((finishedAt - startedAt) / 1000)}s`, summary);
      } else {
        this.db.prepare('UPDATE providers SET consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?').run(error ?? 'Sync failed', providerId);
        log.warn(`Sync ${runId} failed: ${error}`);
      }
      this.state.last[providerId] = { ok, finishedAt, summary, error };
      this.state.running = null;
      this.emit('change', this.state);
      if (ok) this.emit('catalogChanged', providerId);
      this.pump('scheduled');
    };
    worker.on('message', (msg: any) => {
      if (msg.type === 'progress' && this.state.running) {
        this.state.running.stage = msg.stage;
        this.state.running.detail = msg.detail;
        this.emit('change', this.state);
      } else if (msg.type === 'done') finish(true, msg.summary);
      else if (msg.type === 'error') {
        if (msg.detail) log.warn(`Sync ${runId} error detail: ${msg.detail}`);
        finish(false, undefined, msg.message);
      }
    });
    worker.on('error', (err) => finish(false, undefined, err.message));
    worker.on('exit', (code) => finish(code === 0 && settled, undefined, `Sync worker exited (${code})`));
  }
}
