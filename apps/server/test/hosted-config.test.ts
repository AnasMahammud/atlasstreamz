import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Simulate Render with none of the ATLAS_* settings configured.
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-hosted-'));
process.env.RENDER = 'true';
process.env.PORT = '10000';
process.env.ATLAS_DATA_DIR = dataDir;
process.env.ATLAS_INITIAL_M3U_URL = '';
for (const k of ['ATLAS_HOST', 'ATLAS_PORT', 'ATLAS_SECURE_COOKIES', 'ATLAS_TRUST_PROXY', 'ATLAS_PUBLIC', 'ATLAS_SETUP_TOKEN']) delete process.env[k];

const { config } = await import('../src/config.ts');

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('safe defaults on Render', () => {
  it('listens on all interfaces on the platform port', () => {
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(10000);
  });

  it('turns on HTTPS cookies, proxy trust and public-network protection', () => {
    expect(config.secureCookies).toBe(true);
    expect(config.trustProxy).toBe(1);
    expect(config.publicMode).toBe(true);
  });

  it('generates a setup code and keeps it with the data, so nobody else can claim the server', () => {
    expect(config.setupTokenGenerated).toBe(true);
    expect(config.setupToken).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    const file = join(dataDir, 'setup-code.txt');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(config.setupToken);
  });
});
