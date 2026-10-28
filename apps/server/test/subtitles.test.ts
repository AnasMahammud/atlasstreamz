import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Isolate this run in its own data directory before any server module loads config.
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-subs-'));
process.env.ATLAS_DATA_DIR = dataDir;
process.env.ATLAS_INITIAL_M3U_URL = '';

const { openDb } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { SyncManager } = await import('../src/sync/manager.ts');
const { CatalogSearch } = await import('../src/catalog.ts');
const { writeCatalog } = await import('../src/sync/import.ts');
const { insertProvider } = await import('../src/providers.ts');
const { createSubtitleService, osLanguages } = await import('../src/subtitles.ts');
const { redact } = await import('../src/log.ts');
const core = await import('@atlas/core');

/* ---------- a stand-in for the OpenSubtitles REST API ---------- */

const API_KEY = 'os-key-123456';
const OS_USER = 'atlasfan';
const OS_PASS = 'os-password-987';
const SRT = '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nGeneral Kenobi.\r\n';

type Call = { method: string; url: URL; headers: Record<string, string>; body?: any };
const calls: Call[] = [];
let quotaUsed = false;

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function sub(fileId: number, language: string, downloads: number, extra: Record<string, unknown> = {}) {
  return {
    id: String(fileId),
    attributes: {
      language,
      release: `Release.${fileId}`,
      download_count: downloads,
      hearing_impaired: false,
      machine_translated: false,
      ai_translated: false,
      from_trusted: true,
      feature_details: { title: 'Superman', year: 2025 },
      files: [{ file_id: fileId, file_name: `release-${fileId}.srt` }],
      ...extra,
    },
  };
}

const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const call: Call = { method: init.method ?? 'GET', url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
  calls.push(call);

  if (url.hostname === 'dl.opensubtitles.com') return new Response(SRT, { status: 200 });
  const path = url.pathname.replace(/^\/api\/v1/, '');
  if (headers['api-key'] !== API_KEY && path !== '/subtitles') return json(403, { message: 'You cannot consume this service' });
  // Like the real API: unknown keys can still search, but not use consumer-only endpoints.
  if (path === '/discover/popular') return json(200, { data: [] });
  if (path === '/login') {
    if (call.body?.username === OS_USER && call.body?.password === OS_PASS) return json(200, { token: 'jwt-token', base_url: 'vip-api.opensubtitles.com', user: { allowed_downloads: 20 } });
    // The real API answers 400 (not 401) when an email address is used as the username.
    if (String(call.body?.username).includes('.example')) {
      return json(400, { message: 'Error, invalid username/password   - remember to use your username and not your email to authenticate', status: 400 });
    }
    return json(401, { message: 'Error, invalid username/password' });
  }
  if (path === '/infos/user') return json(200, { data: { allowed_downloads: 20, remaining_downloads: 19 } });
  if (path === '/subtitles') {
    const p = url.searchParams;
    if (p.get('tmdb_id') === '1061474') {
      return json(200, { data: [sub(11, 'en', 50, { machine_translated: true }), sub(12, 'en', 900), sub(12, 'en', 900), sub(13, 'en', 300)] });
    }
    if (p.get('parent_tmdb_id') === '95396' && p.get('season_number') === '1' && p.get('episode_number') === '2') {
      return json(200, { data: [sub(21, 'en', 40, { feature_details: { parent_title: 'Severance', season_number: 1, episode_number: 2 } })] });
    }
    if (p.get('query') === 'movie 101') return json(200, { data: [sub(31, 'en', 10, { feature_details: { title: 'Movie 101', year: 1999 } })] });
    return json(200, { data: [] });
  }
  if (path === '/download') {
    if (quotaUsed) return json(406, { message: 'You have downloaded your allowed 20 subtitles for 24h', reset_time: '5 hours' });
    return json(200, { link: `https://dl.opensubtitles.com/download/${call.body.file_id}/file.srt`, file_name: 'file.srt', remaining: 18 });
  }
  return json(404, {});
}) as typeof fetch;

/* ---------- app ---------- */

const db = openDb(join(dataDir, 'test.sqlite'));
const search = new CatalogSearch();
const app = await buildApp({ db, sync: new SyncManager(db), search, subtitles: createSubtitleService(db, dataDir, fakeFetch) });

function client() {
  let cookie = '';
  return async (opts: { method?: string; url: string; body?: unknown }) => {
    const res = await app.inject({
      method: (opts.method ?? 'GET') as any,
      url: opts.url,
      payload: opts.body as any,
      headers: { ...(cookie ? { cookie } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set[0] : set).split(';')[0];
    const type = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, type, text: res.body, json: res.body && type.includes('json') ? JSON.parse(res.body) : {} };
  };
}

const PROVIDER = insertProvider(db, null, 'Test', { type: 'xtream', baseUrl: 'https://panel.example', username: 'user1', password: 'secret-pass' });
db.prepare('UPDATE providers SET http_consent = 1').run();
const MOVIE = `${PROVIDER}:movie:100`;
const UNKNOWN_MOVIE = `${PROVIDER}:movie:101`;
const EPISODE = `${PROVIDER}:episode:5002`;
const CHANNEL = `${PROVIDER}:live:7`;

const owner = client();
const guest = client();

beforeAll(async () => {
  const movie = (sid: string, title: string, tmdbId?: string, year?: number) => ({
    item: {
      id: `${PROVIDER}:movie:${sid}`,
      providerId: PROVIDER,
      sourceId: sid,
      title,
      year,
      tmdbId,
      categoryId: `${PROVIDER}:category:movie-1`,
      isAdult: false,
      addedAt: Date.now(),
      matchKey: core.matchKey('movie', title, 2025),
      container: 'mp4',
    },
  });
  writeCatalog(db, PROVIDER, 1, {
    categories: [
      { id: `${PROVIDER}:category:movie-1`, providerId: PROVIDER, kind: 'movie', sourceId: '1', name: 'Action', genre: 'action', sort: 0 },
      { id: `${PROVIDER}:category:series-1`, providerId: PROVIDER, kind: 'series', sourceId: '2', name: 'Drama', genre: 'drama', sort: 1 },
      { id: `${PROVIDER}:category:live-1`, providerId: PROVIDER, kind: 'live', sourceId: '3', name: 'News', genre: 'news', sort: 2 },
    ],
    channels: [{ item: { id: CHANNEL, providerId: PROVIDER, sourceId: '7', name: 'BBC One', categoryId: `${PROVIDER}:category:live-1`, number: 1, isAdult: false, matchKey: core.matchKey('live', 'BBC One') } }],
    // The second has no TMDB ID or year from the provider, only a tagged title.
    movies: [movie('100', 'Superman', '1061474', 2025), movie('101', 'UK: Movie 101 (1999) 4K')],
    series: [
      {
        id: `${PROVIDER}:series:500`,
        providerId: PROVIDER,
        sourceId: '500',
        title: 'Severance',
        year: 2022,
        tmdbId: '95396',
        categoryId: `${PROVIDER}:category:series-1`,
        isAdult: false,
        addedAt: Date.now(),
        matchKey: core.matchKey('series', 'Severance', 2022),
      },
    ],
  });
  db.prepare('INSERT INTO episodes (id, provider_id, series_id, source_id, season, episode, title, container) VALUES (?, ?, ?, ?, 1, 2, ?, ?)').run(
    EPISODE,
    PROVIDER,
    `${PROVIDER}:series:500`,
    '5002',
    'Half Loop',
    'mkv',
  );
  search.rebuild(db);
  await owner({ method: 'POST', url: '/api/setup', body: { email: 'owner@example.com', password: 'correct horse battery' } });
  const profile = (await owner({ method: 'POST', url: '/api/profiles', body: { name: 'Alex', avatar: 'aurora' } })).json.id;
  await owner({ method: 'POST', url: `/api/profiles/${profile}/select`, body: {} });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('OpenSubtitles settings', () => {
  it('starts switched off', async () => {
    expect((await owner({ url: '/api/settings/subtitles' })).json).toEqual({ configured: false });
    expect((await owner({ url: `/api/play/${MOVIE}` })).json.onlineSubtitles).toBe(false);
    const res = await owner({ url: `/api/subtitles/search?id=${encodeURIComponent(MOVIE)}` });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('not_configured');
  });

  it('is owner-only', async () => {
    expect((await guest({ url: '/api/settings/subtitles' })).status).toBe(401);
    expect((await guest({ method: 'PUT', url: '/api/settings/subtitles', body: { apiKey: API_KEY } })).status).toBe(401);
  });

  it('checks the key and account with OpenSubtitles before saving', async () => {
    const badKey = await owner({ method: 'PUT', url: '/api/settings/subtitles', body: { apiKey: 'wrong-key' } });
    expect(badKey.status).toBe(400);
    expect(badKey.json).toMatchObject({ code: 'auth', error: 'OpenSubtitles didn’t accept that API key.' });
    const badLogin = await owner({ method: 'PUT', url: '/api/settings/subtitles', body: { apiKey: API_KEY, username: OS_USER, password: 'nope' } });
    expect(badLogin.json.code).toBe('auth');
    // Email addresses are refused by OpenSubtitles; say so instead of a vague error.
    const email = await owner({ method: 'PUT', url: '/api/settings/subtitles', body: { apiKey: API_KEY, username: 'me@mail.com', password: OS_PASS } });
    expect(email.status).toBe(400);
    expect(email.json.error).toContain('username, not your email');
    expect((await owner({ url: '/api/settings/subtitles' })).json.configured).toBe(false);

    const ok = await owner({ method: 'PUT', url: '/api/settings/subtitles', body: { apiKey: API_KEY, username: OS_USER, password: OS_PASS } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ configured: true, username: OS_USER, remaining: 19, allowed: 20 });
    expect(JSON.stringify(ok.json)).not.toContain(API_KEY);
  });

  it('stores the key and password encrypted, never sends them to clients and keeps them out of logs', async () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'opensubtitles'").get() as { value: string };
    expect(row.value).not.toContain(API_KEY);
    expect(row.value).not.toContain(OS_PASS);
    expect(JSON.stringify((await owner({ url: '/api/settings/subtitles' })).json)).not.toContain(OS_PASS);
    expect(redact(`key ${API_KEY} pass ${OS_PASS}`)).toBe('key *** pass ***');
  });

  it('keeps saved secrets when the form is saved with blank fields', async () => {
    const res = await owner({ method: 'PUT', url: '/api/settings/subtitles', body: { apiKey: '', username: OS_USER, password: '' } });
    expect(res.json).toMatchObject({ configured: true, username: OS_USER });
  });
});

describe('searching and downloading', () => {
  it('flags titles that can use online subtitles', async () => {
    expect((await owner({ url: `/api/play/${MOVIE}` })).json.onlineSubtitles).toBe(true);
    expect((await owner({ url: `/api/play/${CHANNEL}` })).json.onlineSubtitles).toBe(false);
  });

  it('matches a movie by its TMDB ID, with sorted lower-case parameters and the API headers', async () => {
    calls.length = 0;
    const res = await owner({ url: `/api/subtitles/search?id=${encodeURIComponent(MOVIE)}&lang=en` });
    expect(res.status).toBe(200);
    expect(res.json.match).toBe('id');
    // Duplicates removed; people's translations before machine ones, then by downloads.
    expect(res.json.results.map((r: any) => r.fileId)).toEqual([12, 13, 11]);
    expect(res.json.results[2].machineTranslated).toBe(true);
    const search = calls.find((c) => c.url.pathname.endsWith('/subtitles'))!;
    expect(search.url.search).toBe('?languages=en&tmdb_id=1061474&type=movie');
    expect(search.headers['api-key']).toBe(API_KEY);
    expect(search.headers['user-agent']).toMatch(/^ATLAS v/);
  });

  it('falls back to the cleaned-up title and says the match needs checking', async () => {
    calls.length = 0;
    const res = await owner({ url: `/api/subtitles/search?id=${encodeURIComponent(UNKNOWN_MOVIE)}&lang=en` });
    expect(res.json.match).toBe('title');
    expect(res.json.results[0]).toMatchObject({ fileId: 31, match: 'title', feature: 'Movie 101 (1999)' });
    // The API's canonical form (anything else is redirected): sorted, lower-case, "+" for spaces.
    expect(calls.at(-1)!.url.search).toBe('?languages=en&query=movie+101&type=movie&year=1999');
  });

  it('finds episodes by the series TMDB ID, season and episode', async () => {
    const res = await owner({ url: `/api/subtitles/search?id=${encodeURIComponent(EPISODE)}&lang=en` });
    expect(res.json).toMatchObject({ match: 'id', results: [{ fileId: 21, feature: 'Severance S1E2' }] });
  });

  it('uses the profile’s subtitle language, and covers regional variants', async () => {
    calls.length = 0;
    await owner({ url: `/api/subtitles/search?id=${encodeURIComponent(MOVIE)}` });
    expect(calls.at(-1)!.url.searchParams.get('languages')).toBe('en');
    expect(osLanguages('pt')).toBe('pt-br,pt-pt');
    expect(osLanguages('all')).toBeUndefined();
  });

  it('doesn’t offer online subtitles for live channels', async () => {
    expect((await owner({ url: `/api/subtitles/search?id=${encodeURIComponent(CHANNEL)}` })).status).toBe(404);
  });

  it('downloads through the signed-in account, converts to WebVTT and serves it', async () => {
    calls.length = 0;
    const res = await owner({ method: 'POST', url: '/api/subtitles/download', body: { fileId: 12 } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ url: '/api/subtitles/file/12.vtt', remaining: 18 });
    const dl = calls.find((c) => c.url.pathname.endsWith('/download'))!;
    expect(dl.url.hostname).toBe('vip-api.opensubtitles.com');
    expect(dl.headers.authorization).toBe('Bearer jwt-token');
    expect(dl.body).toEqual({ file_id: 12, sub_format: 'srt' });

    const file = await owner({ url: res.json.url });
    expect(file.status).toBe(200);
    expect(file.type).toContain('text/vtt');
    expect(file.text).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello there.\n\n00:00:04.000 --> 00:00:06.000\nGeneral Kenobi.\n');
    expect((await guest({ url: res.json.url })).status).toBe(401);
  });

  it('reuses downloaded subtitles without spending the allowance', async () => {
    calls.length = 0;
    expect((await owner({ method: 'POST', url: '/api/subtitles/download', body: { fileId: 12 } })).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('explains when the daily allowance is used up', async () => {
    quotaUsed = true;
    const res = await owner({ method: 'POST', url: '/api/subtitles/download', body: { fileId: 13 } });
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('quota');
    expect(res.json.error).toContain('5 hours');
    quotaUsed = false;
  });

  it('rejects unknown files', async () => {
    expect((await owner({ method: 'POST', url: '/api/subtitles/download', body: { fileId: 'x' } })).status).toBe(400);
    expect((await owner({ url: '/api/subtitles/file/999.vtt' })).status).toBe(404);
    expect((await owner({ url: '/api/subtitles/file/..%2Fsecret.key' })).status).toBe(404);
  });

  it('passes on OpenSubtitles’ own reason when it answers unexpectedly', async () => {
    const down = createSubtitleService(db, dataDir, (async () => json(503, { message: 'Service unavailable' })) as typeof fetch);
    await expect(down.search({ kind: 'movie', title: 'Superman', tmdbId: '1061474' }, 'en')).rejects.toThrow('(503: Service unavailable)');
  });

  it('can be switched off again', async () => {
    expect((await owner({ method: 'DELETE', url: '/api/settings/subtitles' })).json).toEqual({ configured: false });
    expect((await owner({ url: `/api/play/${MOVIE}` })).json.onlineSubtitles).toBe(false);
  });
});
