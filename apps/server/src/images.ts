import { createReadStream, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { config } from './config.ts';
import { sha256 } from './security.ts';
import { upstreamFetch } from './providers.ts';

/**
 * Artwork proxy with a disk cache. Used for plain-HTTP logos (which would otherwise be
 * mixed content), and keeps artwork available when the network is down.
 */
const dir = join(config.dataDir, 'images');
const MAX_BYTES = 4 * 1024 * 1024;
const inflight = new Map<string, Promise<string | null>>();

function cachePath(url: string): string {
  return join(dir, sha256(url));
}

async function fetchToCache(url: string): Promise<string | null> {
  const path = cachePath(url);
  try {
    const res = await upstreamFetch(url, { timeoutMs: 10_000, headers: { Accept: 'image/*' } });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    writeFileSync(path, buf);
    writeFileSync(`${path}.type`, type);
    return path;
  } catch {
    return null;
  }
}

export async function serveImage(url: string, res: ServerResponse): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    res.writeHead(400).end();
    return;
  }
  const path = cachePath(url);
  let file: string | null = existsSync(path) ? path : null;
  if (!file) {
    let p = inflight.get(url);
    if (!p) {
      p = fetchToCache(url).finally(() => inflight.delete(url));
      inflight.set(url, p);
    }
    file = await p;
  }
  if (!file) {
    res.writeHead(404, { 'Cache-Control': 'public, max-age=3600' }).end();
    return;
  }
  const type = existsSync(`${file}.type`) ? readFileSync(`${file}.type`, 'utf8') : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800, immutable', 'Access-Control-Allow-Origin': '*' });
  createReadStream(file).pipe(res);
}

export function imageCacheStats(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.type')) continue;
    files++;
    bytes += statSync(join(dir, name)).size;
  }
  return { files, bytes };
}

export function clearImageCache(): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    unlinkSync(join(dir, name));
    if (!name.endsWith('.type')) n++;
  }
  return n;
}
