/**
 * Sync runs in a worker thread with its own SQLite connection, so downloading and parsing
 * a 50 MB playlist never blocks stream proxying or API requests on the main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db.ts';
import { runProviderSync, SyncError } from './import.ts';

const { providerId, runId } = workerData as { providerId: string; runId: number };
const db = openDb();

runProviderSync(db, providerId, runId, (stage, detail) => parentPort?.postMessage({ type: 'progress', stage, detail }))
  .then((summary) => parentPort?.postMessage({ type: 'done', summary }))
  .catch((err: unknown) => {
    const code = err instanceof SyncError ? err.code : 'network';
    const message = err instanceof SyncError ? err.message : 'Sync failed unexpectedly.';
    parentPort?.postMessage({ type: 'error', code, message, detail: err instanceof Error ? err.stack : String(err) });
  })
  .finally(() => db.close());
