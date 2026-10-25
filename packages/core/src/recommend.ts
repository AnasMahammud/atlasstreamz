import type { HistoryEntry } from './models.ts';

export interface RecommendCandidate {
  id: string;
  kind: 'movie' | 'series' | 'live';
  title: string;
  categoryId?: string;
  genres?: string[];
  rating?: number;
  addedAt?: number;
}

export interface Recommendation {
  id: string;
  score: number;
  /** Human-readable reason shown in the UI ("Because you watch Comedy"). */
  reason: string;
}

export interface RecommendOptions {
  now?: number;
  limit?: number;
  /** Half-life of a viewing signal, in days. Older viewing counts less. */
  halfLifeDays?: number;
  excludeIds?: Set<string>;
}

/**
 * Transparent content-based recommender.
 *
 * Builds a taste profile from the profile's history (genre and category weights,
 * weighted by completion and recency), then scores each candidate by overlap with that
 * profile plus small freshness and provider-rating priors. No external services, no
 * opaque models — every score can be explained by its `reason`.
 */
export function recommend(candidates: RecommendCandidate[], history: HistoryEntry[], opts: RecommendOptions = {}): Recommendation[] {
  const now = opts.now ?? Date.now();
  const halfLife = (opts.halfLifeDays ?? 30) * 86_400_000;
  const limit = opts.limit ?? 30;

  const genreW = new Map<string, number>();
  const catW = new Map<string, number>();
  const watched = new Set<string>();
  for (const h of history) {
    watched.add(h.contentId);
    const age = Math.max(0, now - h.watchedAt);
    const w = Math.pow(0.5, age / halfLife) * (0.3 + 0.7 * clamp01(h.completion));
    for (const g of h.genres ?? []) genreW.set(g.toLowerCase(), (genreW.get(g.toLowerCase()) ?? 0) + w);
    if (h.categoryId) catW.set(h.categoryId, (catW.get(h.categoryId) ?? 0) + w);
  }
  const maxG = Math.max(1e-9, ...genreW.values());
  const maxC = Math.max(1e-9, ...catW.values());
  const hasTaste = genreW.size > 0 || catW.size > 0;

  const out: Recommendation[] = [];
  for (const c of candidates) {
    if (watched.has(c.id) || opts.excludeIds?.has(c.id)) continue;
    let taste = 0;
    let reasonGenre: string | undefined;
    let bestG = 0;
    for (const g of c.genres ?? []) {
      const w = (genreW.get(g.toLowerCase()) ?? 0) / maxG;
      if (w > bestG) {
        bestG = w;
        reasonGenre = g;
      }
      taste += w;
    }
    if (c.genres?.length) taste /= Math.sqrt(c.genres.length);
    const catScore = c.categoryId ? (catW.get(c.categoryId) ?? 0) / maxC : 0;
    taste = taste * 0.6 + catScore * 0.4;
    if (hasTaste && taste <= 0) continue;

    const ageDays = c.addedAt ? Math.max(0, (now - c.addedAt) / 86_400_000) : 365;
    const freshness = Math.exp(-ageDays / 90);
    const rating = c.rating ? clamp01((c.rating - 5) / 4) : 0.3;
    const score = (hasTaste ? taste * 0.7 : 0) + freshness * 0.2 + rating * 0.1;
    out.push({
      id: c.id,
      score,
      reason: hasTaste && reasonGenre ? `Because you watch ${reasonGenre}` : hasTaste ? 'Similar to what you watch' : 'New and well rated',
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
