import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// A public deployment sets ATLAS_SETUP_TOKEN; the owner account can't be claimed without it.
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-setup-'));
process.env.ATLAS_DATA_DIR = dataDir;
process.env.ATLAS_INITIAL_M3U_URL = '';
process.env.ATLAS_SETUP_TOKEN = 'render-generated-code';
process.env.ATLAS_SECURE_COOKIES = 'true';

const { openDb } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { SyncManager } = await import('../src/sync/manager.ts');
const { CatalogSearch } = await import('../src/catalog.ts');

const db = openDb(join(dataDir, 'test.sqlite'));
const app = await buildApp({ db, sync: new SyncManager(db), search: new CatalogSearch() });

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const setup = (body: unknown) => app.inject({ method: 'POST', url: '/api/setup', payload: body as any, headers: { 'content-type': 'application/json' } });

describe('public deployment setup', () => {
  it('announces that a setup code is needed', async () => {
    const res = await app.inject({ url: '/api/status' });
    expect(res.json()).toMatchObject({ setupRequired: true, setupCodeRequired: true });
  });

  it('refuses to create the owner without the right code', async () => {
    expect((await setup({ email: 'me@example.com', password: 'a long enough password' })).statusCode).toBe(401);
    expect((await setup({ email: 'me@example.com', password: 'a long enough password', setupCode: 'guess' })).statusCode).toBe(401);
  });

  it('accepts the right code and issues a Secure cookie', async () => {
    const res = await setup({ email: 'me@example.com', password: 'a long enough password', setupCode: ' render-generated-code ' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/Secure/);
    expect((await app.inject({ url: '/api/status' })).json().setupCodeRequired).toBe(false);
  });
});
