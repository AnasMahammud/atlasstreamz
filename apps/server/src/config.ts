import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');

/** Minimal .env parser: KEY=VALUE lines, # comments, optional quotes. No interpolation. */
function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const fileEnv = { ...loadEnvFile(join(repoRoot, '.env')), ...loadEnvFile(join(repoRoot, '.env.local')) };
const env = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

/** "true"/"false" or a hop count. Behind Render's proxy use a hop count so X-Forwarded-For can't be spoofed. */
function trustProxySetting(raw: string | undefined): boolean | number {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : false;
}

export const config = {
  host: env('ATLAS_HOST') ?? '127.0.0.1',
  // Hosting platforms (Render, Railway, Fly…) assign the port through PORT.
  port: Number(env('ATLAS_PORT') ?? env('PORT') ?? 4870),
  trustProxy: trustProxySetting(env('ATLAS_TRUST_PROXY')),
  /** Mark the session cookie Secure. Required when served over HTTPS. */
  secureCookies: env('ATLAS_SECURE_COOKIES') === 'true',
  /**
   * One-time setup code. When set, creating the owner account requires it, so a publicly
   * reachable server can't be claimed by whoever finds the URL first.
   */
  setupToken: env('ATLAS_SETUP_TOKEN') || undefined,
  /**
   * Internet-facing deployment. Upstream fetches (playlists, guides, streams, artwork) may then
   * only reach public addresses, so members can't use the server to probe its private network.
   */
  publicMode: env('ATLAS_PUBLIC') === 'true',
  dataDir: resolve(env('ATLAS_DATA_DIR') ?? join(repoRoot, 'data')),
  webDist: join(repoRoot, 'apps/web/dist'),
  initialProvider: {
    url: env('ATLAS_INITIAL_M3U_URL'),
    name: env('ATLAS_INITIAL_PROVIDER_NAME') ?? 'Primary provider',
  },
  /** 24 h between automatic provider refreshes. */
  syncIntervalMs: Number(env('ATLAS_SYNC_INTERVAL_MS') ?? 24 * 3_600_000),
  /** EPG window kept in the database. */
  epgPastMs: 6 * 3_600_000,
  epgFutureMs: 3 * 24 * 3_600_000,
  userAgent: env('ATLAS_USER_AGENT') ?? 'ATLAS/0.1',
  sessionDays: 30,
  isDev: process.env.NODE_ENV !== 'production',
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, 'images'), { recursive: true });
