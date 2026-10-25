import { normalizeBaseUrl, parseAccountInfo, xtreamFromPlaylistUrl, xtreamUrls, type XtreamAccountInfo, type XtreamCredentials } from '@atlas/core';
import type { DB } from './db.ts';
import { getSetting, setSetting } from './db.ts';
import { config } from './config.ts';
import { decrypt, encrypt, randomToken } from './security.ts';
import { log, registerSecret } from './log.ts';
import { assertPublicDestination } from './netguard.ts';

export type ProviderSecret =
  | ({ type: 'xtream' } & XtreamCredentials & { epgUrl?: string })
  | { type: 'm3u'; url: string; epgUrl?: string };

export interface ProviderRow {
  id: string;
  account_id: string | null;
  name: string;
  type: 'xtream' | 'm3u';
  secret_enc: string;
  display_host: string;
  is_https: number;
  http_consent: number;
  enabled: number;
  auto_sync: number;
  account_json: string | null;
  last_success_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: number;
}

/** What the client may see about a provider. Never includes credentials or full URLs. */
export interface PublicProvider {
  id: string;
  name: string;
  type: 'xtream' | 'm3u';
  host: string;
  secure: boolean;
  needsHttpConsent: boolean;
  enabled: boolean;
  autoSync: boolean;
  account?: Pick<XtreamAccountInfo, 'auth' | 'status' | 'expiresAt' | 'isTrial' | 'maxConnections' | 'activeConnections' | 'outputFormats'>;
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  consecutiveFailures: number;
  lastError?: string;
}

export function secretUrl(secret: ProviderSecret): string {
  return secret.type === 'xtream' ? secret.baseUrl : secret.url;
}

export function toPublic(row: ProviderRow): PublicProvider {
  const account = row.account_json ? (JSON.parse(row.account_json) as XtreamAccountInfo) : undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.display_host,
    secure: row.is_https === 1,
    needsHttpConsent: row.is_https === 0 && row.http_consent === 0,
    enabled: row.enabled === 1,
    autoSync: row.auto_sync === 1,
    account: account
      ? {
          auth: account.auth,
          status: account.status,
          expiresAt: account.expiresAt,
          isTrial: account.isTrial,
          maxConnections: account.maxConnections,
          activeConnections: account.activeConnections,
          outputFormats: account.outputFormats,
        }
      : undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error ?? undefined,
  };
}

/** All providers (for the scheduler), or only those belonging to one account. */
export function listProviders(db: DB, accountId?: string): ProviderRow[] {
  if (accountId === undefined) return db.prepare('SELECT * FROM providers ORDER BY created_at').all() as unknown as ProviderRow[];
  return db.prepare('SELECT * FROM providers WHERE account_id = ? ORDER BY created_at').all(accountId) as unknown as ProviderRow[];
}

/** IDs of an account's providers that may be browsed and played. */
export function accountProviderIds(db: DB, accountId: string): string[] {
  return (db.prepare('SELECT id FROM providers WHERE account_id = ? AND enabled = 1').all(accountId) as Array<{ id: string }>).map((r) => r.id);
}

export function providerOwnedBy(db: DB, providerId: string, accountId: string): boolean {
  return !!db.prepare('SELECT 1 FROM providers WHERE id = ? AND account_id = ?').get(providerId, accountId);
}

export function getProvider(db: DB, id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
}

export function getSecret(row: ProviderRow): ProviderSecret {
  const plain = decrypt(row.secret_enc);
  if (!plain) throw new Error('Provider credentials could not be decrypted. Re-enter the provider in Settings.');
  const secret = JSON.parse(plain) as ProviderSecret;
  if (secret.type === 'xtream') {
    registerSecret(secret.username);
    registerSecret(secret.password);
  } else {
    for (const v of new URL(secret.url).searchParams.values()) registerSecret(v);
  }
  return secret;
}

/** Build the canonical secret from user input. A get.php link becomes an Xtream account. */
export function secretFromInput(input: { m3uUrl?: string; serverUrl?: string; username?: string; password?: string; epgUrl?: string }): ProviderSecret {
  if (input.serverUrl && input.username && input.password) {
    return { type: 'xtream', baseUrl: normalizeBaseUrl(input.serverUrl), username: input.username.trim(), password: input.password, epgUrl: input.epgUrl || undefined };
  }
  if (input.m3uUrl) {
    const url = input.m3uUrl.trim();
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Playlist URL must start with http:// or https://');
    const xt = xtreamFromPlaylistUrl(url);
    if (xt) return { type: 'xtream', ...xt, epgUrl: input.epgUrl || undefined };
    return { type: 'm3u', url, epgUrl: input.epgUrl || undefined };
  }
  throw new Error('Enter a playlist URL, or a server URL with username and password.');
}

export function insertProvider(db: DB, accountId: string | null, name: string, secret: ProviderSecret): string {
  const id = `p${randomToken(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || '1'}`;
  const url = new URL(secretUrl(secret));
  db.prepare(
    `INSERT INTO providers (id, account_id, name, type, secret_enc, display_host, is_https, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, name.trim() || url.hostname, secret.type, encrypt(JSON.stringify(secret)), url.host, url.protocol === 'https:' ? 1 : 0, Date.now());
  return id;
}

/** Import the provider from .env.local once. It is then stored encrypted in the database. */
export function ensureInitialProvider(db: DB): void {
  const { url, name } = config.initialProvider;
  if (!url || getSetting(db, 'initial_provider_imported', false)) return;
  try {
    const secret = secretFromInput({ m3uUrl: url });
    // Belongs to the server owner. Before setup there is no owner yet; it is attached on creation.
    const owner = db.prepare(`SELECT id FROM accounts WHERE role = 'owner'`).get() as { id: string } | undefined;
    const id = insertProvider(db, owner?.id ?? null, name, secret);
    setSetting(db, 'initial_provider_imported', true);
    log.info(`Imported initial ${secret.type} provider ${id} from local environment`);
  } catch (err) {
    log.error('Could not import initial provider from environment', err);
  }
}

/**
 * Fetch from a provider. `timeoutMs` bounds the whole request; with `streaming` it only
 * bounds the wait for response headers, so long-running video bodies are not cut off.
 * In public mode every hop, redirects included, must resolve to a public address.
 */
export async function upstreamFetch(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; streaming?: boolean } = {},
): Promise<Response> {
  const headers = { 'User-Agent': config.userAgent, Accept: '*/*', ...opts.headers };
  let signal: AbortSignal;
  let clear = () => {};
  if (!opts.streaming) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  } else {
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(new DOMException('Connection timed out', 'TimeoutError')), opts.timeoutMs ?? 15_000);
    clear = () => clearTimeout(timer);
    signal = opts.signal ? AbortSignal.any([opts.signal, connect.signal]) : connect.signal;
  }
  try {
    if (!config.publicMode) return await fetch(url, { redirect: 'follow', signal, headers });
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicDestination(current);
      const res = await fetch(current, { redirect: 'manual', signal, headers });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) {
        // Report the final URL as a followed redirect would; HLS rewriting resolves against it.
        if (current !== url) Object.defineProperty(res, 'url', { value: current, configurable: true });
        return res;
      }
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
    }
    throw new Error('Too many redirects.');
  } finally {
    clear();
  }
}

export interface ConnectionTest {
  ok: boolean;
  type: 'xtream' | 'm3u';
  message: string;
  account?: XtreamAccountInfo;
  latencyMs?: number;
}

/** Validate credentials / reachability without importing anything. */
export async function testConnection(secret: ProviderSecret): Promise<ConnectionTest> {
  const started = Date.now();
  try {
    if (secret.type === 'xtream') {
      const res = await upstreamFetch(xtreamUrls.api(secret), { timeoutMs: 15_000 });
      if (!res.ok) return { ok: false, type: 'xtream', message: `Provider responded with HTTP ${res.status}.` };
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, type: 'xtream', message: 'The server did not return Xtream API data. Check the server URL.' };
      }
      const account = parseAccountInfo(json);
      if (!account.auth) return { ok: false, type: 'xtream', message: 'The provider rejected these credentials.', account };
      if (account.status && account.status.toLowerCase() !== 'active') return { ok: false, type: 'xtream', message: `Account status: ${account.status}.`, account };
      return { ok: true, type: 'xtream', message: 'Connected.', account, latencyMs: Date.now() - started };
    }
    const res = await upstreamFetch(secret.url, { timeoutMs: 20_000 });
    if (!res.ok) return { ok: false, type: 'm3u', message: `Playlist responded with HTTP ${res.status}.` };
    const reader = res.body?.getReader();
    let head = '';
    if (reader) {
      while (head.length < 2048) {
        const { value, done } = await reader.read();
        if (done) break;
        head += new TextDecoder().decode(value);
      }
      await reader.cancel().catch(() => {});
    }
    if (!/^﻿?\s*#EXTM3U/i.test(head)) return { ok: false, type: 'm3u', message: 'This URL did not return an M3U playlist.' };
    return { ok: true, type: 'm3u', message: 'Playlist reachable.', latencyMs: Date.now() - started };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'TimeoutError' ? 'The provider did not respond in time.' : 'Could not reach the provider.';
    return { ok: false, type: secret.type, message: msg };
  }
}
