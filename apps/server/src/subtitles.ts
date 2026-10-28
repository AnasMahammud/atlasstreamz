/**
 * Online subtitles from OpenSubtitles.
 *
 * Uses the opensubtitles.com REST API, which replaced the retired opensubtitles.org XML-RPC API
 * and serves the same subtitle library. The server owner adds an API key, and optionally an
 * OpenSubtitles account for a larger daily download allowance, in Settings → Subtitles. Both are
 * stored encrypted and never leave the server: viewers search and download through ATLAS.
 *
 * Downloads are converted to WebVTT and cached on disk, so playing the same subtitles again
 * (on any device) doesn't use the daily allowance.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanTitle, toVtt } from '@atlas/core';
import { getSetting, setSetting, type DB } from './db.ts';
import { registerSecret } from './log.ts';
import { decrypt, encrypt } from './security.ts';

const API = 'https://api.opensubtitles.com/api/v1';
const SETTING = 'opensubtitles';
const USER_AGENT = 'ATLAS v0.3';
const TIMEOUT_MS = 15_000;
const SESSION_MS = 12 * 3_600_000; // OpenSubtitles tokens last 24 h
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_CACHED = 400;

/** Some languages are split by region on OpenSubtitles. */
const LANGUAGE_GROUPS: Record<string, string[]> = { pt: ['pt-br', 'pt-pt'], zh: ['zh-cn', 'zh-tw'] };

type Credentials = { apiKey: string; username?: string; password?: string };
type Stored = { apiKey: string; username?: string; password?: string }; // apiKey and password encrypted

export type SearchTarget =
  | { kind: 'movie'; title: string; year?: number | null; tmdbId?: string | null }
  | { kind: 'episode'; seriesTitle: string; year?: number | null; seriesTmdbId?: string | null; season: number; episode: number };

export type SubtitleResult = {
  fileId: number;
  /** OpenSubtitles language code, e.g. "en" or "pt-br". */
  language: string;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  /** Machine or AI translated rather than made by a person. */
  machineTranslated: boolean;
  trusted: boolean;
  /** "id": matched by the title's TMDB ID. "title": matched by name only, so it may be a different film or show. */
  match: 'id' | 'title';
  /** What OpenSubtitles thinks it belongs to, e.g. "The Accountant (2016)" or "Severance S1E2". */
  feature?: string;
};

export type SubtitleStatus = {
  configured: boolean;
  username?: string;
  /** Downloads left today, when signed in to an OpenSubtitles account. */
  remaining?: number;
  allowed?: number;
  error?: string;
};

export class SubtitleError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code?: 'not_configured' | 'auth' | 'quota' | 'busy' | 'invalid',
  ) {
    super(message);
  }
}

/** OpenSubtitles language codes for a profile's language (e.g. "pt" → "pt-br,pt-pt"), or undefined for all. */
export function osLanguages(lang?: string | null): string | undefined {
  if (!lang || lang === 'all') return undefined;
  const codes = lang
    .toLowerCase()
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^[a-z]{2}(-[a-z]{2})?$/.test(c))
    .flatMap((c) => LANGUAGE_GROUPS[c] ?? [c]);
  return codes.length ? [...new Set(codes)].sort().join(',') : undefined;
}

/** Provider titles often carry region tags and years: "UK: The Accountant (2016) 4K" → "The Accountant", 2016. */
const searchTitle = (title: string) => cleanTitle(title).title;

/** The API redirects queries that aren't in its canonical form: sorted, lower-case, spaces as "+". */
function queryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k].toLowerCase()).replace(/%20/g, '+')}`)
    .join('&');
}

function featureLabel(f: any): string | undefined {
  if (!f || typeof f !== 'object') return undefined;
  if (f.season_number != null && f.episode_number != null && (f.parent_title || f.title)) {
    return `${f.parent_title ?? f.title} S${f.season_number}E${f.episode_number}`;
  }
  const title = f.title ?? f.movie_name;
  if (!title) return undefined;
  return f.year ? `${title} (${f.year})` : String(title);
}

function toResults(data: any, match: 'id' | 'title'): SubtitleResult[] {
  const seen = new Set<number>();
  const out: SubtitleResult[] = [];
  for (const item of Array.isArray(data?.data) ? data.data : []) {
    const a = item?.attributes ?? {};
    const file = Array.isArray(a.files) ? a.files[0] : undefined;
    const fileId = Number(file?.file_id);
    if (!Number.isSafeInteger(fileId) || fileId <= 0 || seen.has(fileId)) continue;
    seen.add(fileId);
    out.push({
      fileId,
      language: String(a.language ?? '').toLowerCase(),
      release: String(a.release || file?.file_name || 'Subtitles').slice(0, 160),
      downloads: Number(a.download_count) || 0,
      hearingImpaired: !!a.hearing_impaired,
      machineTranslated: !!(a.machine_translated || a.ai_translated),
      trusted: !!a.from_trusted,
      match,
      feature: featureLabel(a.feature_details),
    });
  }
  // Made by people first, then the most downloaded.
  return out.sort((x, y) => Number(x.machineTranslated) - Number(y.machineTranslated) || y.downloads - x.downloads).slice(0, 40);
}

export type SubtitleService = ReturnType<typeof createSubtitleService>;

export function createSubtitleService(db: DB, dataDir: string, fetchImpl: typeof fetch = fetch) {
  const cacheDir = join(dataDir, 'subtitles');
  let session: { token: string; base: string; at: number } | null = null;

  const load = (): Credentials | null => {
    const s = getSetting<Stored | null>(db, SETTING, null);
    const apiKey = s?.apiKey ? decrypt(s.apiKey) : null;
    if (!apiKey) return null;
    const password = s?.password ? (decrypt(s.password) ?? undefined) : undefined;
    registerSecret(apiKey);
    registerSecret(password);
    return { apiKey, username: s?.username, password };
  };

  const need = (): Credentials => {
    const c = load();
    if (!c) throw new SubtitleError('Online subtitles aren’t set up on this server yet.', 409, 'not_configured');
    return c;
  };

  async function call(c: Credentials, path: string, opts: { method?: string; body?: unknown; base?: string; token?: string } = {}): Promise<any> {
    const headers: Record<string, string> = { 'Api-Key': c.apiKey, 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await fetchImpl((opts.base ?? API) + path, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SubtitleError('Couldn’t reach OpenSubtitles. Try again in a moment.', 502, 'busy');
    }
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (res.ok) return data;
    if (res.status === 401 || res.status === 403) throw new SubtitleError('OpenSubtitles didn’t accept the API key or account details. Check them in Settings → Subtitles.', 502, 'auth');
    if (res.status === 406) {
      const reset = typeof data?.reset_time === 'string' ? ` It resets in ${data.reset_time}.` : '';
      throw new SubtitleError(`Today’s OpenSubtitles download allowance is used up.${reset}`, 429, 'quota');
    }
    if (res.status === 429) throw new SubtitleError('OpenSubtitles is busy. Try again in a few seconds.', 429, 'busy');
    throw new SubtitleError('OpenSubtitles had a problem with that request. Try again later.', 502);
  }

  /** Sign in to the owner's OpenSubtitles account, if one is set, for the account's download allowance. */
  async function signIn(c: Credentials, force = false): Promise<typeof session> {
    if (!c.username || !c.password) return null;
    if (!force && session && Date.now() - session.at < SESSION_MS) return session;
    const data = await call(c, '/login', { method: 'POST', body: { username: c.username, password: c.password } });
    if (typeof data?.token !== 'string') throw new SubtitleError('OpenSubtitles didn’t sign in. Check the account details in Settings → Subtitles.', 502, 'auth');
    // VIP accounts are given their own API host. Only ever follow it to an OpenSubtitles domain.
    const host = typeof data.base_url === 'string' ? data.base_url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    const base = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.opensubtitles\.com$/i.test(host) ? `https://${host}/api/v1` : API;
    session = { token: data.token, base, at: Date.now() };
    return session;
  }

  const cachePath = (fileId: number) => join(cacheDir, `${fileId}.vtt`);

  function pruneCache(): void {
    try {
      const files = readdirSync(cacheDir).filter((f) => f.endsWith('.vtt'));
      if (files.length <= MAX_CACHED) return;
      files
        .map((f) => ({ f, t: statSync(join(cacheDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .slice(0, files.length - MAX_CACHED)
        .forEach(({ f }) => unlinkSync(join(cacheDir, f)));
    } catch {
      /* best effort */
    }
  }

  async function status(): Promise<SubtitleStatus> {
    const c = load();
    if (!c) return { configured: false };
    const out: SubtitleStatus = { configured: true, username: c.username };
    if (c.username) {
      try {
        const s = await signIn(c);
        const data = await call(c, '/infos/user', { base: s?.base, token: s?.token });
        const d = data?.data ?? {};
        if (Number.isFinite(d.remaining_downloads)) out.remaining = d.remaining_downloads;
        if (Number.isFinite(d.allowed_downloads)) out.allowed = d.allowed_downloads;
      } catch (err) {
        out.error = (err as Error).message;
      }
    }
    return out;
  }

  return {
    configured: (): boolean => !!load(),
    status,

    /** Check the details with OpenSubtitles, then store them encrypted. Blank fields keep what's saved. */
    async save(input: { apiKey?: string; username?: string; password?: string }): Promise<SubtitleStatus> {
      const prev = load();
      const apiKey = input.apiKey?.trim() || prev?.apiKey;
      if (!apiKey) throw new SubtitleError('Enter your OpenSubtitles API key.', 400, 'invalid');
      const username = input.username === undefined ? prev?.username : input.username.trim() || undefined;
      const password = input.password || (username && username === prev?.username ? prev?.password : undefined);
      if (username && !password) throw new SubtitleError('Enter the password for that OpenSubtitles account.', 400, 'invalid');
      const next: Credentials = { apiKey, username, password };
      session = null;
      // Searching and /infos work without a valid key, so check it on an endpoint that needs one.
      try {
        if (username) await signIn(next, true);
        else await call(next, '/discover/popular');
      } catch (err) {
        if (err instanceof SubtitleError && err.code === 'auth') {
          throw new SubtitleError(username ? 'OpenSubtitles didn’t accept that API key, username or password.' : 'OpenSubtitles didn’t accept that API key.', 400, 'auth');
        }
        throw err;
      }
      const stored: Stored = { apiKey: encrypt(apiKey), username, password: password ? encrypt(password) : undefined };
      setSetting(db, SETTING, stored);
      return status();
    },

    clear(): void {
      session = null;
      db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING);
    },

    /** Search by TMDB ID first; fall back to the title when that finds nothing. */
    async search(target: SearchTarget, language?: string | null): Promise<{ results: SubtitleResult[]; match: 'id' | 'title' }> {
      const c = need();
      const languages = osLanguages(language);
      const common: Record<string, string> = languages ? { languages } : {};
      const attempts: Array<{ params: Record<string, string>; match: 'id' | 'title' }> = [];
      if (target.kind === 'movie') {
        const tmdb = target.tmdbId?.replace(/\D/g, '');
        if (tmdb) attempts.push({ params: { ...common, tmdb_id: tmdb, type: 'movie' }, match: 'id' });
        const year = target.year ?? cleanTitle(target.title).year;
        attempts.push({ params: { ...common, query: searchTitle(target.title), type: 'movie', ...(year ? { year: String(year) } : {}) }, match: 'title' });
      } else {
        const ep = { episode_number: String(target.episode), season_number: String(target.season) };
        const tmdb = target.seriesTmdbId?.replace(/\D/g, '');
        if (tmdb) attempts.push({ params: { ...common, ...ep, parent_tmdb_id: tmdb, type: 'episode' }, match: 'id' });
        attempts.push({ params: { ...common, ...ep, query: searchTitle(target.seriesTitle), type: 'episode' }, match: 'title' });
      }
      let match: 'id' | 'title' = 'title';
      for (const attempt of attempts) {
        match = attempt.match;
        const results = toResults(await call(c, `/subtitles?${queryString(attempt.params)}`), attempt.match);
        if (results.length) return { results, match };
      }
      return { results: [], match };
    },

    /** Download a subtitle file into the cache as WebVTT. Cached files cost nothing to reuse. */
    async download(fileId: number): Promise<{ cached: boolean; remaining?: number }> {
      if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new SubtitleError('Unknown subtitle file.', 400, 'invalid');
      if (existsSync(cachePath(fileId))) return { cached: true };
      const c = need();
      let s = await signIn(c);
      const request = () => call(c, '/download', { method: 'POST', body: { file_id: fileId, sub_format: 'srt' }, base: s?.base, token: s?.token });
      let data: any;
      try {
        data = await request();
      } catch (err) {
        // An expired account session: sign in again once.
        if (!(err instanceof SubtitleError && err.code === 'auth' && s)) throw err;
        s = await signIn(c, true);
        data = await request();
      }
      const link = typeof data?.link === 'string' ? data.link : '';
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        throw new SubtitleError('OpenSubtitles didn’t return a download link.', 502);
      }
      if (url.protocol !== 'https:' || !/(^|\.)opensubtitles\.(com|org)$/i.test(url.hostname)) throw new SubtitleError('OpenSubtitles returned an unexpected download link.', 502);
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new SubtitleError('Couldn’t download the subtitles. Try again in a moment.', 502, 'busy');
      }
      if (!res.ok) throw new SubtitleError('Couldn’t download the subtitles. Try again in a moment.', 502, 'busy');
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) throw new SubtitleError('That subtitle file is too large.', 502);
      // OpenSubtitles serves UTF-8, but some older files are Windows-1252.
      let text = new TextDecoder('utf-8').decode(bytes);
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes);
      let vtt: string;
      try {
        vtt = toVtt(typeof data.file_name === 'string' ? data.file_name : 'subtitles.srt', text);
      } catch {
        throw new SubtitleError('That subtitle file isn’t in a format ATLAS can show.', 502);
      }
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath(fileId), vtt);
      pruneCache();
      return { cached: false, remaining: Number.isFinite(data.remaining) ? data.remaining : undefined };
    },

    /** A downloaded subtitle file as WebVTT, or null if it hasn't been downloaded. */
    cached(fileId: number): string | null {
      if (!Number.isSafeInteger(fileId) || fileId <= 0) return null;
      try {
        return readFileSync(cachePath(fileId), 'utf8');
      } catch {
        return null;
      }
    },
  };
}
