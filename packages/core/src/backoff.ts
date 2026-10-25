/** Exponential backoff with full jitter, capped. `attempt` starts at 0. */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 60_000, random: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Sync scheduling: a successful sync is due again after `intervalMs`; failures back off. */
export function nextSyncAt(opts: { lastSuccessAt?: number; lastAttemptAt?: number; consecutiveFailures: number; intervalMs: number; now: number }): number {
  const { lastSuccessAt, lastAttemptAt, consecutiveFailures, intervalMs, now } = opts;
  if (consecutiveFailures > 0 && lastAttemptAt) {
    // 5 min, 10, 20, 40 … capped at 6 h — never hammer a provider that is down.
    const wait = Math.min(6 * 3_600_000, 5 * 60_000 * Math.pow(2, consecutiveFailures - 1));
    return lastAttemptAt + wait;
  }
  if (!lastSuccessAt) return now;
  return lastSuccessAt + intervalMs;
}
