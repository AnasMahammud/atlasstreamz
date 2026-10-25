import { describe, expect, it } from 'vitest';
import { SearchIndex, backoffDelay, boundedDistance, isValidPin, nextSyncAt, pinLockoutMs, recommend } from '../src/index.ts';

const docs = [
  { id: 'm1', kind: 'movie' as const, title: 'The Accountant 2', extra: 'Ben Affleck' },
  { id: 'm2', kind: 'movie' as const, title: 'Superman' },
  { id: 'm3', kind: 'movie' as const, title: 'Super Mario Bros' },
  { id: 's1', kind: 'series' as const, title: 'MobLand' },
  { id: 'l1', kind: 'live' as const, title: 'Sky Sports Main Event' },
  { id: 'l2', kind: 'live' as const, title: 'Adult Channel', isAdult: true },
];

describe('search', () => {
  const idx = new SearchIndex(docs);

  it('ranks exact and prefix matches first', () => {
    const r = idx.search('superman');
    expect(r[0].id).toBe('m2');
    expect(r[0].match).toBe('exact');
    expect(idx.search('super').map((h) => h.id).slice(0, 2).sort()).toEqual(['m2', 'm3']);
  });

  it('tolerates typos', () => {
    expect(idx.search('acountant')[0]?.id).toBe('m1');
    expect(idx.search('mobladn')[0]?.id).toBe('s1');
    expect(idx.search('sky sprots')[0]?.id).toBe('l1');
  });

  it('matches extra text with lower weight, filters by kind and hides adult content', () => {
    expect(idx.search('affleck')[0]?.id).toBe('m1');
    expect(idx.search('sky', { kinds: ['movie'] })).toHaveLength(0);
    expect(idx.search('adult')).toHaveLength(0);
    expect(idx.search('adult', { includeAdult: true })[0]?.id).toBe('l2');
  });

  it('bounded distance handles transpositions and exits early', () => {
    expect(boundedDistance('abcd', 'abdc', 1)).toBe(1);
    expect(boundedDistance('kitten', 'sitting', 1)).toBe(2);
  });
});

describe('recommendations', () => {
  const now = Date.UTC(2026, 9, 25);
  const cands = [
    { id: 'c1', kind: 'movie' as const, title: 'Funny', genres: ['Comedy'], addedAt: now - 86_400_000 },
    { id: 'c2', kind: 'movie' as const, title: 'Scary', genres: ['Horror'], addedAt: now - 86_400_000 },
    { id: 'c3', kind: 'movie' as const, title: 'Watched', genres: ['Comedy'] },
  ];

  it('follows the profile taste and explains why', () => {
    const r = recommend(cands, [{ contentId: 'c3', kind: 'movie', genres: ['Comedy'], watchedAt: now, completion: 1 }], { now });
    expect(r.map((x) => x.id)).toEqual(['c1']);
    expect(r[0].reason).toBe('Because you watch Comedy');
  });

  it('falls back to fresh titles for a new profile', () => {
    const r = recommend(cands, [], { now });
    expect(r).toHaveLength(3);
    expect(r[0].reason).toBe('New and well rated');
  });
});

describe('PIN and backoff rules', () => {
  it('validates 4–6 digit PINs', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('123456')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('1234567')).toBe(false);
  });

  it('locks out after repeated failures with growing waits', () => {
    expect(pinLockoutMs(4)).toBe(0);
    expect(pinLockoutMs(5)).toBe(30_000);
    expect(pinLockoutMs(6)).toBe(60_000);
    expect(pinLockoutMs(50)).toBe(3_600_000);
  });

  it('backs off sync attempts after failures and never hammers', () => {
    const now = 1_000_000_000;
    expect(nextSyncAt({ consecutiveFailures: 0, intervalMs: 86_400_000, now })).toBe(now);
    expect(nextSyncAt({ lastSuccessAt: now, consecutiveFailures: 0, intervalMs: 86_400_000, now })).toBe(now + 86_400_000);
    expect(nextSyncAt({ lastAttemptAt: now, consecutiveFailures: 1, intervalMs: 86_400_000, now })).toBe(now + 300_000);
    expect(nextSyncAt({ lastAttemptAt: now, consecutiveFailures: 20, intervalMs: 86_400_000, now })).toBe(now + 6 * 3_600_000);
    expect(backoffDelay(3, 1000, 60_000, () => 0)).toBe(4000);
    expect(backoffDelay(30, 1000, 60_000, () => 1)).toBe(60_000);
  });
});

describe('quality labels', () => {
  it('labels letterboxed widescreen encodes by their width', async () => {
    const { qualityFromHeight } = await import('../src/index.ts');
    expect(qualityFromHeight(800, 1920)).toBe('1080p');
    expect(qualityFromHeight(576, 1024)).toBe('SD');
    expect(qualityFromHeight(1608, 3840)).toBe('4K');
    expect(qualityFromHeight(undefined)).toBeUndefined();
  });
});

describe('search filter', () => {
  it('only returns documents the caller may see', async () => {
    const { SearchIndex } = await import('../src/index.ts');
    const idx = new SearchIndex([
      { id: 'pA:movie:1', kind: 'movie', title: 'Superman' },
      { id: 'pB:movie:1', kind: 'movie', title: 'Superman' },
    ]);
    expect(idx.search('superman', { filter: (d) => d.id.startsWith('pB:') }).map((h) => h.id)).toEqual(['pB:movie:1']);
    expect(idx.suggest('super', 5, (d) => d.id.startsWith('pC:'))).toEqual([]);
  });
});
