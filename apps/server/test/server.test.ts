import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Isolate every test run in its own data directory before any server module loads config.
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-test-'));
process.env.ATLAS_DATA_DIR = dataDir;
process.env.ATLAS_INITIAL_M3U_URL = '';

const { openDb } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { SyncManager } = await import('../src/sync/manager.ts');
const { CatalogSearch } = await import('../src/catalog.ts');
const { writeCatalog } = await import('../src/sync/import.ts');
const { insertProvider } = await import('../src/providers.ts');
const { rewritePlaylist } = await import('../src/stream.ts');
const { redact, registerSecret } = await import('../src/log.ts');
const core = await import('@atlas/core');

const db = openDb(join(dataDir, 'test.sqlite'));
const search = new CatalogSearch();
const app = await buildApp({ db, sync: new SyncManager(db), search });

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
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : {} };
  };
}

// Imported before setup (like .env.local): attached to the owner when the owner is created.
const PROVIDER = insertProvider(db, null, 'Test', { type: 'xtream', baseUrl: 'https://panel.example', username: 'user1', password: 'secret-pass' });
db.prepare('UPDATE providers SET http_consent = 1').run();

function payload(movieIds: string[], channelName = 'BBC One') {
  return {
    categories: [
      { id: `${PROVIDER}:category:movie-1`, providerId: PROVIDER, kind: 'movie' as const, sourceId: '1', name: 'Action & Adventure', genre: 'action', sort: 0 },
      { id: `${PROVIDER}:category:live-1`, providerId: PROVIDER, kind: 'live' as const, sourceId: '1', name: 'UK News', genre: 'news', sort: 1 },
    ],
    channels: [
      {
        item: {
          id: `${PROVIDER}:live:7`,
          providerId: PROVIDER,
          sourceId: '7',
          name: channelName,
          categoryId: `${PROVIDER}:category:live-1`,
          number: 1,
          isAdult: false,
          matchKey: core.matchKey('live', channelName),
        },
      },
    ],
    movies: movieIds.map((sid, i) => ({
      item: {
        id: `${PROVIDER}:movie:${sid}`,
        providerId: PROVIDER,
        sourceId: sid,
        title: i === 0 ? 'Superman' : `Movie ${sid}`,
        year: 2025,
        poster: 'https://image.tmdb.org/t/p/w342/x.jpg',
        categoryId: `${PROVIDER}:category:movie-1`,
        isAdult: false,
        addedAt: Date.now() - i * 1000,
        matchKey: core.matchKey('movie', i === 0 ? 'Superman' : `Movie ${sid}`, 2025),
        container: 'mp4',
      },
    })),
    series: [],
  };
}

beforeAll(() => {
  writeCatalog(db, PROVIDER, 1, payload(['100', '101', '102']));
  search.rebuild(db);
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('accounts, profiles and PINs', () => {
  const owner = client();
  const guest = client();
  let a = '';
  let b = '';

  it('requires setup, then a session, then a profile', async () => {
    expect((await owner({ url: '/api/status' })).json.setupRequired).toBe(true);
    expect((await owner({ method: 'POST', url: '/api/setup', body: { email: 'owner@example.com', password: 'short' } })).status).toBe(400);
    expect((await owner({ method: 'POST', url: '/api/setup', body: { email: 'not-an-email', password: 'correct horse battery' } })).status).toBe(400);
    expect((await owner({ method: 'POST', url: '/api/setup', body: { email: 'owner@example.com', password: 'correct horse battery' } })).status).toBe(200);
    expect((await owner({ method: 'POST', url: '/api/setup', body: { email: 'x@example.com', password: 'again and again' } })).status).toBe(409);
    expect(db.prepare('SELECT account_id FROM providers WHERE id = ?').get(PROVIDER)).toMatchObject({ account_id: expect.stringMatching(/^a/) });
    expect((await guest({ url: '/api/home' })).status).toBe(401);
    expect((await owner({ url: '/api/home' })).status).toBe(409);
  });

  it('never stores PINs or passwords in plain text', async () => {
    a = (await owner({ method: 'POST', url: '/api/profiles', body: { name: 'Alex', avatar: 'aurora' } })).json.id;
    b = (await owner({ method: 'POST', url: '/api/profiles', body: { name: 'Sam', avatar: 'tide', pin: '4321' } })).json.id;
    const row = db.prepare('SELECT pin_hash FROM profiles WHERE id = ?').get(b) as { pin_hash: string };
    expect(row.pin_hash).toMatch(/^scrypt\$/);
    expect(row.pin_hash).not.toContain('4321');
    const pw = db.prepare(`SELECT password_hash FROM accounts WHERE role = 'owner'`).get() as { password_hash: string };
    expect(pw.password_hash).not.toContain('correct horse');
  });

  it('locks a profile after repeated wrong PINs, even for the right PIN', async () => {
    for (let i = 0; i < 4; i++) expect((await owner({ method: 'POST', url: `/api/profiles/${b}/select`, body: { pin: '0000' } })).status).toBe(401);
    const fifth = await owner({ method: 'POST', url: `/api/profiles/${b}/select`, body: { pin: '0000' } });
    expect(fifth.status).toBe(429);
    expect((await owner({ method: 'POST', url: `/api/profiles/${b}/select`, body: { pin: '4321' } })).status).toBe(429);
  });

  it('lets the owner reset a forgotten PIN with the owner password', async () => {
    expect((await owner({ method: 'POST', url: `/api/profiles/${b}/pin`, body: { password: 'wrong password', newPin: '1111' } })).status).toBe(401);
    expect((await owner({ method: 'POST', url: `/api/profiles/${b}/pin`, body: { password: 'correct horse battery', newPin: '1111' } })).status).toBe(200);
    expect((await owner({ method: 'POST', url: `/api/profiles/${b}/select`, body: { pin: '1111' } })).status).toBe(200);
  });

  it('keeps watch progress and lists separate per profile', async () => {
    const movie = `${PROVIDER}:movie:100`;
    expect((await owner({ method: 'PUT', url: `/api/me/progress/${encodeURIComponent(movie)}`, body: { position: 600, duration: 6000 } })).status).toBe(200);
    expect((await owner({ method: 'PUT', url: `/api/me/list/${encodeURIComponent(movie)}` })).status).toBe(200);
    expect((await owner({ url: '/api/me/continue' })).json.items.map((c: any) => c.id)).toEqual([movie]);
    expect((await owner({ method: 'POST', url: `/api/profiles/${a}/select`, body: {} })).status).toBe(200);
    expect((await owner({ url: '/api/me/continue' })).json.items).toEqual([]);
    expect((await owner({ url: '/api/me/list' })).json.items).toEqual([]);
  });

  it('marks titles finished near the end', async () => {
    const r = await owner({ method: 'PUT', url: `/api/me/progress/${encodeURIComponent(`${PROVIDER}:movie:101`)}`, body: { position: 5950, duration: 6000 } });
    expect(r.json.finished).toBe(true);
  });

  it('blocks cross-origin writes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://evil.example', host: 'localhost' } });
    expect(res.statusCode).toBe(403);
  });

  it('only reports verified quality from real measurements', async () => {
    const id = encodeURIComponent(`${PROVIDER}:movie:100`);
    expect((await owner({ method: 'POST', url: `/api/me/quality/${id}`, body: { width: -1, height: 0 } })).status).toBe(400);
    expect((await owner({ method: 'POST', url: `/api/me/quality/${id}`, body: { width: 1920, height: 800 } })).status).toBe(200);
  });

  it('searches with typos and returns playback sources without credentials', async () => {
    const s = await owner({ url: '/api/search?q=supermn' });
    expect(s.json.results[0]?.title).toBe('Superman');
    const p = await owner({ url: `/api/play/${encodeURIComponent(`${PROVIDER}:live:7`)}` });
    expect(p.status).toBe(200);
    expect(JSON.stringify(p.json)).not.toContain('secret-pass');
    expect(p.json.sources[0].url).toMatch(/^\/api\/stream\/live\//);
  });
});

describe('separate accounts', () => {
  const owner = client();
  const friend = client();
  const stranger = client();
  let ownerProfile = '';

  it('signs the owner in by email, without revealing which emails exist', async () => {
    expect((await owner({ method: 'POST', url: '/api/auth/login', body: { email: 'nobody@example.com', password: 'whatever123' } })).json.error).toBe('That email or password is not right.');
    expect((await owner({ method: 'POST', url: '/api/auth/login', body: { email: 'OWNER@example.com', password: 'correct horse battery' } })).status).toBe(200);
    ownerProfile = (await owner({ url: '/api/profiles' })).json.profiles[0].id;
    expect((await owner({ method: 'POST', url: `/api/profiles/${ownerProfile}/select`, body: {} })).status).toBe(200);
  });

  it('is invite-only by default, and invites are single-use', async () => {
    expect((await owner({ url: '/api/status' })).json.registration).toBe('invite');
    expect((await friend({ method: 'POST', url: '/api/auth/register', body: { email: 'friend@example.com', password: 'friendpass1' } })).status).toBe(401);
    const invite = (await owner({ method: 'POST', url: '/api/admin/invites', body: { label: 'Friend' } })).json;
    expect(invite.code).toMatch(/^[A-Z0-9]{6,}$/);
    expect((await friend({ method: 'POST', url: '/api/auth/register', body: { email: 'friend@example.com', password: 'friendpass1', inviteCode: invite.code.toLowerCase() } })).status).toBe(200);
    expect((await stranger({ method: 'POST', url: '/api/auth/register', body: { email: 'stranger@example.com', password: 'strangerpass', inviteCode: invite.code } })).status).toBe(401);
    expect((await friend({ url: '/api/admin/accounts' })).status).toBe(403);
  });

  it('gives a new account its own empty profiles and no access to other accounts', async () => {
    expect((await friend({ url: '/api/profiles' })).json.profiles).toEqual([]);
    const fp = (await friend({ method: 'POST', url: '/api/profiles', body: { name: 'Jo', avatar: 'ember' } })).json.id;
    expect((await friend({ method: 'POST', url: `/api/profiles/${fp}/select`, body: {} })).status).toBe(200);
    expect((await friend({ method: 'POST', url: `/api/profiles/${ownerProfile}/select`, body: {} })).status).toBe(404);
    expect((await friend({ url: '/api/providers' })).json.providers).toEqual([]);
    expect((await friend({ url: '/api/search?q=superman' })).json.results).toEqual([]);
    expect((await friend({ url: '/api/movies' })).json.total).toBe(0);
    const channel = encodeURIComponent(`${PROVIDER}:live:7`);
    expect((await friend({ url: `/api/play/${channel}` })).status).toBe(404);
    expect((await friend({ url: `/api/channels/${channel}` })).status).toBe(404);
    expect((await friend({ url: `/api/stream/vod/${encodeURIComponent(`${PROVIDER}:movie:100`)}` })).status).toBe(404);
    expect((await friend({ method: 'POST', url: `/api/providers/${PROVIDER}/sync` })).status).toBe(404);
    expect((await friend({ method: 'PUT', url: `/api/me/list/${channel}` })).status).toBe(404);
    // The owner still sees everything of their own.
    expect((await owner({ url: '/api/search?q=superman' })).json.results[0]?.title).toBe('Superman');
  });

  it('lets the owner open or close sign-ups and disable accounts', async () => {
    expect((await owner({ method: 'PUT', url: '/api/admin/registration', body: { mode: 'open' } })).status).toBe(200);
    expect((await stranger({ method: 'POST', url: '/api/auth/register', body: { email: 'stranger@example.com', password: 'strangerpass' } })).status).toBe(200);
    expect((await client()({ method: 'POST', url: '/api/auth/register', body: { email: 'STRANGER@example.com', password: 'strangerpass' } })).status).toBe(409);
    expect((await owner({ method: 'PUT', url: '/api/admin/registration', body: { mode: 'closed' } })).status).toBe(200);
    expect((await client()({ method: 'POST', url: '/api/auth/register', body: { email: 'late@example.com', password: 'latepass123' } })).status).toBe(403);
    const accounts = (await owner({ url: '/api/admin/accounts' })).json.accounts as Array<{ id: string; email: string }>;
    const s = accounts.find((a) => a.email === 'stranger@example.com')!;
    expect((await owner({ method: 'PATCH', url: `/api/admin/accounts/${s.id}`, body: { disabled: true } })).status).toBe(200);
    expect((await stranger({ url: '/api/profiles' })).status).toBe(401);
    expect((await client()({ method: 'POST', url: '/api/auth/login', body: { email: 'stranger@example.com', password: 'strangerpass' } })).status).toBe(403);
    expect((await owner({ method: 'DELETE', url: `/api/admin/accounts/${s.id}` })).status).toBe(200);
  });

  it('lets a member change their password and signs out their other devices', async () => {
    const other = client();
    expect((await other({ method: 'POST', url: '/api/auth/login', body: { email: 'friend@example.com', password: 'friendpass1' } })).status).toBe(200);
    expect((await friend({ method: 'POST', url: '/api/account/password', body: { currentPassword: 'wrong-one!', newPassword: 'newfriendpass' } })).status).toBe(401);
    expect((await friend({ method: 'POST', url: '/api/account/password', body: { currentPassword: 'friendpass1', newPassword: 'newfriendpass' } })).status).toBe(200);
    expect((await other({ url: '/api/profiles' })).status).toBe(401);
    expect((await friend({ url: '/api/profiles' })).status).toBe(200);
  });
});

describe('private network protection', () => {
  it('recognises private, loopback and metadata addresses', async () => {
    const { isPrivateAddress, assertPublicDestination } = await import('../src/netguard.ts');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '94.176.111.226', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
    await expect(assertPublicDestination('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or internal/);
    await expect(assertPublicDestination('http://localhost:4870/api')).rejects.toThrow(/private or internal/);
    await expect(assertPublicDestination('file:///etc/passwd')).rejects.toThrow();
  });
});

describe('catalogue sync', () => {
  it('applies a new catalogue atomically and reports changes', () => {
    const s = writeCatalog(db, PROVIDER, 2, payload(['100', '102', '103'], 'BBC One HD'));
    expect(s.added.movies).toBe(1);
    expect(s.removed.movies).toBe(1);
    expect(s.renamedChannels).toBe(1);
    const ids = (db.prepare('SELECT id FROM movies ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([`${PROVIDER}:movie:100`, `${PROVIDER}:movie:102`, `${PROVIDER}:movie:103`]);
  });

  it('re-attaches favourites and progress when the provider changes a stream id', () => {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE content_id = ?`).get(`${PROVIDER}:movie:100`) as { n: number };
    expect(before.n).toBe(1);
    // Superman moves from stream 100 to 900.
    const s = writeCatalog(db, PROVIDER, 3, payload(['900', '102', '103']));
    expect(s.rematchedUserItems).toBe(2);
    const fav = db.prepare(`SELECT content_id FROM favorites`).all() as Array<{ content_id: string }>;
    expect(fav.map((f) => f.content_id)).toEqual([`${PROVIDER}:movie:900`]);
    const prog = db.prepare(`SELECT content_id FROM progress WHERE position_sec = 600`).get() as { content_id: string };
    expect(prog.content_id).toBe(`${PROVIDER}:movie:900`);
  });
});

describe('stream proxy and logging', () => {
  it('rewrites every HLS URI to an opaque token', () => {
    const out = rewritePlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1"\n#EXTINF:10,\n/hls/abc/seg1.ts\n#EXTINF:10,\nhttps://cdn.example/live/user1/secret-pass/seg2.ts\n',
      'http://edge.example/live/user1/secret-pass/7.m3u8',
      PROVIDER,
    );
    expect(out).not.toContain('secret-pass');
    expect(out).not.toContain('edge.example');
    expect(out.match(/\/api\/stream\/h\//g)).toHaveLength(3);
  });

  it('redacts credentials from log lines', () => {
    registerSecret('secret-pass');
    expect(redact('GET http://p.example/get.php?username=user1&password=secret-pass')).not.toContain('secret-pass');
    expect(redact('http://p.example/live/user1/secret-pass/7.ts')).toBe('http://p.example/live/***/***/7.ts');
  });
});
