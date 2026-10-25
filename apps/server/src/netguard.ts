import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF protection for internet-facing deployments: refuse destinations on loopback,
 * private, link-local (cloud metadata), carrier-grade NAT, multicast or reserved ranges.
 * Hostnames are resolved first, so a public name pointing at 10.0.0.1 is refused too.
 */
export class BlockedDestinationError extends Error {
  constructor(host: string) {
    super(`Refusing to connect to a private or internal address (${host}).`);
  }
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

export async function assertPublicDestination(url: string): Promise<void> {
  const { hostname, protocol } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') throw new BlockedDestinationError(hostname);
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new BlockedDestinationError(host);
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new BlockedDestinationError(host);
}
