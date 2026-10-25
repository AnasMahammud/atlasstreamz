/** Shared PIN rules. Hashing and lockout live on the server; this is validation only. */
export const PIN_MIN = 4;
export const PIN_MAX = 6;

export function isValidPin(pin: string): boolean {
  return /^\d+$/.test(pin) && pin.length >= PIN_MIN && pin.length <= PIN_MAX;
}

/** Lockout schedule after repeated wrong PINs: attempts allowed, then growing waits. */
export const PIN_FREE_ATTEMPTS = 5;
export function pinLockoutMs(failures: number): number {
  if (failures < PIN_FREE_ATTEMPTS) return 0;
  const step = failures - PIN_FREE_ATTEMPTS; // 0, 1, 2, …
  return Math.min(60 * 60_000, 30_000 * Math.pow(2, step)); // 30 s, 1 min, 2 min … capped at 1 h
}
