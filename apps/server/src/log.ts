/**
 * Logging with secret redaction. Provider credentials appear in URLs (query strings and
 * Xtream path segments), so every message passes through `redact()` before output.
 */
const secrets = new Set<string>();

/** Register a value that must never appear in logs (passwords, usernames, tokens). */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 3) secrets.add(value);
}

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? `${input.name}: ${input.message}` : safeJson(input);
  s = s.replace(/((?:username|password|token|pass|user)=)[^&\s"']+/gi, '$1***');
  s = s.replace(/\/(live|movie|series|timeshift)\/[^/\s]+\/[^/\s]+\//gi, '/$1/***/***/');
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join('***');
  return s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info: (...parts: unknown[]) => console.log(`[${stamp()}]`, ...parts.map(redact)),
  warn: (...parts: unknown[]) => console.warn(`[${stamp()}] WARN`, ...parts.map(redact)),
  error: (...parts: unknown[]) => console.error(`[${stamp()}] ERROR`, ...parts.map(redact)),
};
