import { normalizeKey } from './normalize.ts';

export type SearchKind = 'live' | 'movie' | 'series' | 'category';

export interface SearchDoc {
  id: string;
  kind: SearchKind;
  title: string;
  /** Extra searchable text: category name, cast, year. Weighted lower than the title. */
  extra?: string;
  /** Popularity/recency prior in [0, 1]. Breaks ties between equally good matches. */
  prior?: number;
  isAdult?: boolean;
}

export interface SearchHit {
  id: string;
  kind: SearchKind;
  title: string;
  score: number;
  /** How the match was made, for debugging and result explanations. */
  match: 'exact' | 'prefix' | 'word' | 'substring' | 'fuzzy' | 'extra';
}

interface Indexed {
  doc: SearchDoc;
  key: string;
  words: string[];
  extraKey: string;
}

/**
 * Typo-tolerant in-memory search tuned for tens of thousands of titles.
 *
 * Ranking: exact title > title prefix > word prefixes > substring > fuzzy (bounded
 * Damerau–Levenshtein per word) > matches in extra text. A small prior breaks ties.
 */
export class SearchIndex {
  private items: Indexed[] = [];

  constructor(docs: SearchDoc[] = []) {
    this.replace(docs);
  }

  get size(): number {
    return this.items.length;
  }

  replace(docs: SearchDoc[]): void {
    this.items = docs.map((doc) => {
      const key = normalizeKey(doc.title);
      return { doc, key, words: key.split(' ').filter(Boolean), extraKey: normalizeKey(doc.extra ?? '') };
    });
  }

  search(query: string, opts: { limit?: number; kinds?: SearchKind[]; includeAdult?: boolean; filter?: (doc: SearchDoc) => boolean } = {}): SearchHit[] {
    const q = normalizeKey(query);
    if (!q) return [];
    const qWords = q.split(' ').filter(Boolean);
    const limit = opts.limit ?? 60;
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    const hits: SearchHit[] = [];
    for (const it of this.items) {
      if (kinds && !kinds.has(it.doc.kind)) continue;
      if (it.doc.isAdult && !opts.includeAdult) continue;
      if (opts.filter && !opts.filter(it.doc)) continue;
      const scored = scoreItem(it, q, qWords);
      if (!scored) continue;
      hits.push({ id: it.doc.id, kind: it.doc.kind, title: it.doc.title, score: scored.score + (it.doc.prior ?? 0) * 0.05, match: scored.match });
    }
    hits.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
    return hits.slice(0, limit);
  }

  /** Short title completions for the instant-suggestion strip. */
  suggest(query: string, limit = 8, filter?: (doc: SearchDoc) => boolean): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of this.search(query, { limit: limit * 3, filter })) {
      const k = normalizeKey(h.title);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h.title);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function scoreItem(it: Indexed, q: string, qWords: string[]): { score: number; match: SearchHit['match'] } | null {
  const { key, words } = it;
  if (key === q) return { score: 1, match: 'exact' };
  if (key.startsWith(q)) return { score: 0.9 - Math.min(0.1, (key.length - q.length) / 400), match: 'prefix' };

  // Every query word must match some title word (prefix or fuzzy).
  let total = 0;
  let fuzzyUsed = false;
  let allPrefix = true;
  for (const qw of qWords) {
    let best = 0;
    for (const w of words) {
      if (w === qw) {
        best = 1;
        break;
      }
      if (w.startsWith(qw)) best = Math.max(best, 0.85);
      else if (qw.length >= 3 && w.includes(qw)) best = Math.max(best, 0.6);
      else if (qw.length >= 4) {
        const maxEdits = qw.length >= 8 ? 2 : 1;
        // Compare against the word's prefix of similar length so partial typing still matches.
        const target = w.length > qw.length + maxEdits ? w.slice(0, qw.length + 1) : w;
        const d = boundedDistance(qw, target, maxEdits);
        if (d <= maxEdits) {
          best = Math.max(best, 0.55 - d * 0.1);
        }
      }
    }
    if (best === 0) {
      total = 0;
      break;
    }
    if (best < 0.85) allPrefix = false;
    if (best < 0.6) fuzzyUsed = true;
    total += best;
  }
  if (total > 0) {
    const avg = total / qWords.length;
    const match: SearchHit['match'] = fuzzyUsed ? 'fuzzy' : allPrefix ? 'word' : 'substring';
    const base = match === 'word' ? 0.7 : match === 'substring' ? 0.5 : 0.35;
    return { score: base + avg * 0.15, match };
  }
  if (q.length >= 3 && key.includes(q)) return { score: 0.45, match: 'substring' };
  if (q.length >= 3 && it.extraKey && it.extraKey.includes(q)) return { score: 0.2, match: 'extra' };
  return null;
}

/** Optimal-string-alignment distance with an early exit once `max` is exceeded. */
export function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prevPrev: number[] = new Array(n + 1).fill(0);
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = new Array(n + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prevPrev[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[n];
}
