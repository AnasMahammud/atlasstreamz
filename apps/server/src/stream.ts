import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseAccountInfo, parseContentId, xtreamUrls, type XtreamAccountInfo } from '@atlas/core';
import type { DB } from './db.ts';
import { getProvider, getSecret, upstreamFetch, type ProviderRow } from './providers.ts';
import { decrypt, encrypt } from './security.ts';
import { log } from './log.ts';

/**
 * Secure stream proxy.
 *
 * The browser never sees provider URLs (they embed credentials). It asks for
 * `/api/stream/...` and we fetch upstream, follow redirects, rewrite HLS playlists so every
 * segment/variant/key also goes through us as an opaque encrypted token, and pipe bytes
 * back with Range support. Upstream requests are aborted the moment the player goes away,
 * and a new continuous stream for a session closes that session's previous one so we stay
 * within the provider's connection limit.
 */

export type Engine = 'hls' | 'mpegts' | 'native';

export interface PlaybackSource {
  engine: Engine;
  url: string;
  label: string;
  mime?: string;
}

export class PlaybackError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'consent' | 'auth' | 'unavailable',
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  mov: 'video/quicktime',
};

interface Resolved {
  provider: ProviderRow;
  upstream: string;
  kind: 'live' | 'movie' | 'episode';
  container?: string;
  headers?: Record<string, string>;
}

function ensureUsable(provider: ProviderRow | undefined): ProviderRow {
  if (!provider) throw new PlaybackError('This title’s provider was removed.', 'not_found');
  if (provider.is_https === 0 && provider.http_consent === 0) throw new PlaybackError('Allow this provider’s unencrypted HTTP connection in Settings first.', 'consent');
  if (!provider.enabled) throw new PlaybackError('This provider is disabled.', 'unavailable');
  return provider;
}

function accountOf(provider: ProviderRow): XtreamAccountInfo | undefined {
  return provider.account_json ? (JSON.parse(provider.account_json) as XtreamAccountInfo) : undefined;
}

/** Resolve the upstream URL for a content ID. `format` picks an Xtream live output. */
export function resolveUpstream(db: DB, contentId: string, format?: 'm3u8' | 'ts'): Resolved {
  const parsed = parseContentId(contentId);
  if (!parsed || parsed.kind === 'series' || parsed.kind === 'category') throw new PlaybackError('Not a playable item.', 'not_found');
  const provider = ensureUsable(getProvider(db, parsed.providerId));
  const secret = getSecret(provider);
  const table = parsed.kind === 'live' ? 'channels' : parsed.kind === 'movie' ? 'movies' : 'episodes';
  const row = db.prepare(`SELECT source_id, url, ${parsed.kind === 'live' ? 'options_json' : 'container'} AS extra FROM ${table} WHERE id = ?`).get(contentId) as
    | { source_id: string; url: string | null; extra: string | null }
    | undefined;
  if (!row) throw new PlaybackError('This title is no longer offered by the provider.', 'not_found');

  if (row.url) {
    let headers: Record<string, string> | undefined;
    if (parsed.kind === 'live' && row.extra) {
      const opts = JSON.parse(row.extra) as Record<string, string>;
      headers = {};
      if (opts['http-user-agent']) headers['User-Agent'] = opts['http-user-agent'];
      if (opts['http-referrer']) headers.Referer = opts['http-referrer'];
    }
    return { provider, upstream: row.url, kind: parsed.kind, container: parsed.kind === 'live' ? undefined : row.extra ?? undefined, headers };
  }
  if (secret.type !== 'xtream') throw new PlaybackError('No stream URL for this title.', 'unavailable');
  if (parsed.kind === 'live') return { provider, kind: 'live', upstream: xtreamUrls.live(secret, row.source_id, format ?? 'm3u8') };
  const ext = row.extra || 'mp4';
  const upstream = parsed.kind === 'movie' ? xtreamUrls.movie(secret, row.source_id, ext) : xtreamUrls.episode(secret, row.source_id, ext);
  return { provider, kind: parsed.kind, upstream, container: ext };
}

/** Ordered list of engines the client should try for this item. */
export function playbackSources(db: DB, contentId: string): PlaybackSource[] {
  const r = resolveUpstream(db, contentId);
  const id = encodeURIComponent(contentId);
  if (r.kind === 'live') {
    const formats = accountOf(r.provider)?.outputFormats ?? [];
    const isXtream = r.provider.type === 'xtream';
    const sources: PlaybackSource[] = [];
    const looksHls = /\.m3u8(\?|$)/i.test(r.upstream);
    if (isXtream ? formats.length === 0 || formats.includes('m3u8') : looksHls) sources.push({ engine: 'hls', url: `/api/stream/live/${id}/index.m3u8`, label: 'HLS' });
    if (isXtream ? formats.length === 0 || formats.includes('ts') : !looksHls) sources.push({ engine: 'mpegts', url: `/api/stream/live/${id}/stream.ts`, label: 'MPEG-TS' });
    return sources;
  }
  const container = (r.container ?? 'mp4').toLowerCase();
  const sources: PlaybackSource[] = [{ engine: 'native', url: `/api/stream/vod/${id}`, label: container.toUpperCase(), mime: MIME[container] }];
  if (container === 'ts') sources.push({ engine: 'mpegts', url: `/api/stream/vod/${id}`, label: 'MPEG-TS' });
  return sources;
}

/* ---------------- token helpers ---------------- */

interface StreamToken {
  u: string;
  p: string;
  e: number;
}

function tokenFor(upstream: string, providerId: string): string {
  return encrypt(JSON.stringify({ u: upstream, p: providerId, e: Date.now() + 6 * 3_600_000 } satisfies StreamToken));
}

function readToken(token: string): StreamToken | null {
  const plain = decrypt(token);
  if (!plain) return null;
  const t = JSON.parse(plain) as StreamToken;
  return t.e > Date.now() ? t : null;
}

/** Rewrite every URI in an HLS playlist to a proxied token URL. */
export function rewritePlaylist(body: string, baseUrl: string, providerId: string): string {
  const proxied = (uri: string) => {
    let abs: string;
    try {
      abs = new URL(uri, baseUrl).toString();
    } catch {
      return uri;
    }
    return `/api/stream/h/${tokenFor(abs, providerId)}`;
  };
  return body
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return t.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${proxied(uri)}"`);
      return proxied(t);
    })
    .join('\n');
}

/* ---------------- continuous-stream registry ---------------- */

const activeBySession = new Map<string, Set<AbortController>>();

function registerContinuous(sessionKey: string, ac: AbortController): () => void {
  // One continuous stream per session: switching channel closes the previous upstream.
  const set = activeBySession.get(sessionKey) ?? new Set();
  for (const old of set) old.abort();
  set.clear();
  set.add(ac);
  activeBySession.set(sessionKey, set);
  return () => {
    set.delete(ac);
    if (!set.size) activeBySession.delete(sessionKey);
  };
}

/* ---------------- request handlers (raw node req/res) ---------------- */

type Raw = { req: IncomingMessage; res: ServerResponse };

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

function isPlaylist(res: Response, url: string): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(url);
}

async function proxyPlaylistOrBytes({ req, res }: Raw, upstream: string, providerId: string, headers?: Record<string, string>): Promise<void> {
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  let up: Response;
  try {
    up = await upstreamFetch(upstream, { signal: ac.signal, streaming: true, timeoutMs: 15_000, headers });
  } catch (err) {
    if (!ac.signal.aborted) log.warn('Upstream fetch failed', upstream, err);
    return fail(res, 504, 'The stream did not respond.');
  }
  if (!up.ok) {
    await up.body?.cancel().catch(() => {});
    return fail(res, up.status === 401 || up.status === 403 ? 403 : 502, `Upstream HTTP ${up.status}`);
  }
  if (isPlaylist(up, up.url || upstream)) {
    const text = await up.text();
    if (!text.trimStart().startsWith('#EXTM3U')) return fail(res, 502, 'Upstream did not return a playlist.');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(rewritePlaylist(text, up.url || upstream, providerId));
    return;
  }
  pipeBody(up, res, ac);
}

function pipeBody(up: Response, res: ServerResponse, ac: AbortController, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...extraHeaders };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
    const v = up.headers.get(h);
    if (v && !(h in headers)) headers[h] = v;
  }
  res.writeHead(up.status, headers);
  if (!up.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(up.body as any);
  body.on('error', () => res.destroy());
  res.on('close', () => {
    ac.abort();
    body.destroy();
  });
  body.pipe(res);
}

export async function handleLive(db: DB, raw: Raw, contentId: string, kind: 'm3u8' | 'ts', sessionKey: string): Promise<void> {
  let r: Resolved;
  try {
    r = resolveUpstream(db, contentId, kind);
  } catch (err) {
    return fail(raw.res, err instanceof PlaybackError && err.code === 'consent' ? 403 : 404, err instanceof Error ? err.message : 'Not found');
  }
  if (kind === 'm3u8') return proxyPlaylistOrBytes(raw, r.upstream, r.provider.id, r.headers);

  // Continuous MPEG-TS: one per session.
  const ac = new AbortController();
  const release = registerContinuous(sessionKey, ac);
  raw.req.on('close', () => {
    ac.abort();
    release();
  });
  try {
    const up = await upstreamFetch(r.upstream, { signal: ac.signal, streaming: true, timeoutMs: 15_000, headers: r.headers });
    if (!up.ok) {
      await up.body?.cancel().catch(() => {});
      return fail(raw.res, 502, `Upstream HTTP ${up.status}`);
    }
    if (isPlaylist(up, up.url)) {
      // An M3U playlist link that turned out to be HLS.
      const text = await up.text();
      raw.res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      raw.res.end(rewritePlaylist(text, up.url, r.provider.id));
      return;
    }
    pipeBody(up, raw.res, ac, { 'Content-Type': 'video/mp2t' });
  } catch (err) {
    if (!ac.signal.aborted) log.warn('Live TS upstream failed', err);
    fail(raw.res, 504, 'The stream did not respond.');
  }
}

/** `allow` checks the token's provider belongs to the requesting account. */
export async function handleHlsToken(db: DB, raw: Raw, token: string, allow: (providerId: string) => boolean): Promise<void> {
  const t = readToken(token);
  if (!t) return fail(raw.res, 410, 'Stream link expired.');
  if (!allow(t.p)) return fail(raw.res, 404, 'Not found.');
  try {
    ensureUsable(getProvider(db, t.p));
  } catch (err) {
    return fail(raw.res, 403, err instanceof Error ? err.message : 'Forbidden');
  }
  return proxyPlaylistOrBytes(raw, t.u, t.p);
}

export async function handleVod(db: DB, raw: Raw, contentId: string, sessionKey: string): Promise<void> {
  let r: Resolved;
  try {
    r = resolveUpstream(db, contentId);
  } catch (err) {
    return fail(raw.res, err instanceof PlaybackError && err.code === 'consent' ? 403 : 404, err instanceof Error ? err.message : 'Not found');
  }
  const ac = new AbortController();
  // Range requests for seeking open many short connections; only the initial open-ended one counts as continuous.
  const range = raw.req.headers.range;
  const release = !range || /^bytes=0-$/.test(range) ? registerContinuous(sessionKey, ac) : () => {};
  raw.req.on('close', () => {
    ac.abort();
    release();
  });
  try {
    const up = await upstreamFetch(r.upstream, { signal: ac.signal, streaming: true, timeoutMs: 20_000, headers: { ...(range ? { Range: range } : {}), ...r.headers } });
    if (!up.ok && up.status !== 206) {
      await up.body?.cancel().catch(() => {});
      return fail(raw.res, up.status === 416 ? 416 : 502, `Upstream HTTP ${up.status}`);
    }
    const mime = MIME[(r.container ?? '').toLowerCase()];
    pipeBody(up, raw.res, ac, { 'accept-ranges': 'bytes', ...(mime ? { 'content-type': mime } : {}) });
  } catch (err) {
    if (!ac.signal.aborted) log.warn('VOD upstream failed', err);
    fail(raw.res, 504, 'The video did not respond.');
  }
}

/** Live account check used by diagnostics and recovery (does the provider still accept us?). */
export async function providerAuthStatus(db: DB, providerId: string): Promise<'ok' | 'rejected' | 'unreachable'> {
  const p = getProvider(db, providerId);
  if (!p) return 'unreachable';
  const secret = getSecret(p);
  if (secret.type !== 'xtream') return 'ok';
  try {
    const res = await upstreamFetch(xtreamUrls.api(secret), { timeoutMs: 8_000 });
    const info = parseAccountInfo(await res.json());
    db.prepare('UPDATE providers SET account_json = ? WHERE id = ?').run(JSON.stringify(info), providerId);
    return info.auth ? 'ok' : 'rejected';
  } catch {
    return 'unreachable';
  }
}
