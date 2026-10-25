import {
  GENRE_LABELS,
  SearchIndex,
  parseContentId,
  parseSeriesInfo,
  parseVodInfo,
  recommend,
  xtreamUrls,
  type MovieDetails,
  type SearchDoc,
} from '@atlas/core';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { getProvider, getSecret, upstreamFetch } from './providers.ts';
import type { ProfilePrefs } from './auth.ts';
import { log } from './log.ts';

/* ---------------- client-facing shapes ---------------- */

export interface Card {
  id: string;
  kind: 'movie' | 'series' | 'live' | 'episode';
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  logo?: string;
  rating?: number;
  addedAt?: number;
  categoryId?: string;
  category?: string;
  number?: number;
  progress?: { position: number; duration: number };
  subtitle?: string;
  now?: { title: string; start: number; stop: number };
  next?: { title: string; start: number; stop: number };
  verifiedQuality?: string;
  isNew?: boolean;
  reason?: string;
  /** For Continue Watching episodes: the series to open. */
  seriesId?: string;
}

export interface Row {
  id: string;
  title: string;
  layout: 'poster' | 'landscape' | 'channel' | 'continue';
  items: Card[];
  href?: string;
  note?: string;
}

/* ---------------- audience filtering ---------------- */

export interface Audience {
  kids: boolean;
  regions: string[];
  /** The signed-in account's enabled providers. Nothing outside this list is ever returned. */
  providers: string[];
}

export function audienceFor(prefs: ProfilePrefs, isKids: boolean, providers: string[]): Audience {
  return { kids: isKids || prefs.maturity === 'kids', regions: (prefs.regions ?? []).map((r) => r.toUpperCase()), providers };
}

/** `alias.provider_id IN (...)` for the account's providers; matches nothing when there are none. */
export function providerSql(a: Pick<Audience, 'providers'>, alias: string): string {
  const ids = a.providers.filter((p) => /^[a-zA-Z0-9]+$/.test(p));
  return ids.length ? `${alias}.provider_id IN (${ids.map((p) => `'${p}'`).join(',')})` : '0';
}

/** SQL fragment limiting rows by account, adult flag, kids mode and region preference. */
function audienceSql(a: Audience, alias: string, opts: { regions?: boolean } = {}): string {
  const parts = [providerSql(a, alias), `${alias}.is_adult = 0`, `COALESCE(c.is_adult, 0) = 0`];
  if (a.kids) parts.push(`c.genre IN ('kids','animation')`);
  if (opts.regions !== false) {
    const list = a.regions.map((r) => `'${r.replace(/[^A-Z]/g, '')}'`).join(',');
    parts.push(list ? `(c.region IS NULL OR c.region IN (${list}))` : `c.region IS NULL`);
  }
  return parts.join(' AND ');
}

const NEW_MS = 7 * 86_400_000;

function movieCard(r: any): Card {
  return {
    id: r.id,
    kind: 'movie',
    title: r.title,
    year: r.year ?? undefined,
    poster: r.poster ?? undefined,
    backdrop: r.backdrop ?? undefined,
    rating: r.rating ?? undefined,
    addedAt: r.added_at ?? undefined,
    categoryId: r.category_id ?? undefined,
    category: r.category_name ?? undefined,
    isNew: r.added_at ? Date.now() - r.added_at < NEW_MS : undefined,
  };
}

function seriesCard(r: any): Card {
  return {
    id: r.id,
    kind: 'series',
    title: r.title,
    year: r.year ?? undefined,
    poster: r.poster ?? undefined,
    backdrop: r.backdrop ?? undefined,
    rating: r.rating ?? undefined,
    addedAt: r.added_at ?? undefined,
    categoryId: r.category_id ?? undefined,
    category: r.category_name ?? undefined,
    isNew: r.added_at ? Date.now() - r.added_at < NEW_MS : undefined,
  };
}

function channelCard(r: any): Card {
  return {
    id: r.id,
    kind: 'live',
    title: r.name,
    logo: r.logo ?? undefined,
    number: r.number ?? undefined,
    categoryId: r.category_id ?? undefined,
    category: r.category_name ?? undefined,
  };
}

/* ---------------- EPG ---------------- */

export interface ProgrammeOut {
  title: string;
  start: number;
  stop: number;
  desc?: string;
  category?: string;
}

/** Attach now/next programmes to channel cards in one query. */
export function attachNowNext(db: DB, cards: Card[]): Card[] {
  const live = cards.filter((c) => c.kind === 'live');
  if (!live.length) return cards;
  const ids = live.map((c) => c.id);
  const map = new Map<string, { provider_id: string; epg_id: string }>();
  const rows = db.prepare(`SELECT id, provider_id, epg_id FROM channels WHERE id IN (${ids.map(() => '?').join(',')}) AND epg_id IS NOT NULL`).all(...ids) as Array<{
    id: string;
    provider_id: string;
    epg_id: string;
  }>;
  for (const r of rows) map.set(r.id, r);
  const now = Date.now();
  const q = db.prepare('SELECT title, start, stop FROM programmes WHERE provider_id = ? AND channel_epg_id = ? AND stop > ? ORDER BY start LIMIT 2');
  for (const c of live) {
    const m = map.get(c.id);
    if (!m) continue;
    const [a, b] = q.all(m.provider_id, m.epg_id, now) as Array<{ title: string; start: number; stop: number }>;
    if (a && a.start <= now) {
      c.now = a;
      if (b) c.next = b;
    } else if (a) c.next = a;
  }
  return cards;
}

export function programmesFor(db: DB, channelIds: string[], from: number, to: number): Record<string, ProgrammeOut[]> {
  if (!channelIds.length) return {};
  const chans = db.prepare(`SELECT id, provider_id, epg_id FROM channels WHERE id IN (${channelIds.map(() => '?').join(',')})`).all(...channelIds) as Array<{
    id: string;
    provider_id: string;
    epg_id: string | null;
  }>;
  const q = db.prepare('SELECT title, start, stop, descr, category FROM programmes WHERE provider_id = ? AND channel_epg_id = ? AND stop > ? AND start < ? ORDER BY start LIMIT 200');
  const out: Record<string, ProgrammeOut[]> = {};
  for (const c of chans) {
    out[c.id] = c.epg_id
      ? (q.all(c.provider_id, c.epg_id, from, to) as any[]).map((p) => ({ title: p.title, start: p.start, stop: p.stop, desc: p.descr ?? undefined, category: p.category ?? undefined }))
      : [];
  }
  return out;
}

/* ---------------- browse ---------------- */

/** Channels per category that have guide listings. Cached until the catalogue changes. */
let guideCoverage: { at: number; map: Map<string, number> } | null = null;
export function invalidateGuideCoverage(): void {
  guideCoverage = null;
}
function guideCounts(db: DB): Map<string, number> {
  if (guideCoverage && Date.now() - guideCoverage.at < 30 * 60_000) return guideCoverage.map;
  const rows = db
    .prepare(
      `SELECT t.category_id AS id, COUNT(*) AS n FROM channels t
       WHERE t.epg_id IS NOT NULL AND EXISTS (SELECT 1 FROM programmes p WHERE p.provider_id = t.provider_id AND p.channel_epg_id = t.epg_id AND p.stop > ?)
       GROUP BY t.category_id`,
    )
    .all(Date.now()) as Array<{ id: string; n: number }>;
  guideCoverage = { at: Date.now(), map: new Map(rows.map((r) => [r.id, r.n])) };
  return guideCoverage.map;
}

export function listCategories(db: DB, kind: 'live' | 'movie' | 'series', a: Audience) {
  const kidsFilter = a.kids ? `AND c.genre IN ('kids','animation')` : '';
  const guide = kind === 'live' ? guideCounts(db) : null;
  return (
    db.prepare(`SELECT c.id, c.name, c.genre, c.region, c.item_count FROM categories c WHERE ${providerSql(a, 'c')} AND c.kind = ? AND c.is_adult = 0 AND c.item_count > 0 ${kidsFilter} ORDER BY c.provider_id, c.sort`).all(kind) as any[]
  ).map((c) => ({ id: c.id, name: c.name, genre: c.genre ?? undefined, region: c.region ?? undefined, count: c.item_count, guideCount: guide?.get(c.id) ?? undefined }));
}

export type SortKey = 'added' | 'title' | 'year' | 'rating';

export function browse(
  db: DB,
  kind: 'movie' | 'series',
  a: Audience,
  opts: { categoryId?: string; sort?: SortKey; yearFrom?: number; yearTo?: number; offset?: number; limit?: number; genre?: string },
): { items: Card[]; total: number } {
  const table = kind === 'movie' ? 'movies' : 'series';
  const where = [audienceSql(a, 't', { regions: !opts.categoryId })];
  const params: Array<string | number> = [];
  if (opts.categoryId) {
    where.push('t.category_id = ?');
    params.push(opts.categoryId);
  }
  if (opts.genre) {
    where.push('c.genre = ?');
    params.push(opts.genre);
  }
  if (opts.yearFrom) {
    where.push('t.year >= ?');
    params.push(opts.yearFrom);
  }
  if (opts.yearTo) {
    where.push('t.year <= ?');
    params.push(opts.yearTo);
  }
  const order =
    opts.sort === 'title' ? 't.title COLLATE NOCASE ASC' : opts.sort === 'year' ? 't.year DESC NULLS LAST, t.added_at DESC' : opts.sort === 'rating' ? 't.rating DESC NULLS LAST' : 't.added_at DESC NULLS LAST';
  const base = `FROM ${table} t LEFT JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params) as { n: number }).n;
  const limit = Math.min(200, opts.limit ?? 60);
  const rows = db.prepare(`SELECT t.*, c.name AS category_name ${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, opts.offset ?? 0);
  return { items: rows.map(kind === 'movie' ? movieCard : seriesCard), total };
}

export function browseChannels(db: DB, a: Audience, opts: { categoryId?: string; offset?: number; limit?: number }): { items: Card[]; total: number } {
  const where = [audienceSql(a, 't', { regions: false })];
  const params: Array<string | number> = [];
  if (opts.categoryId) {
    where.push('t.category_id = ?');
    params.push(opts.categoryId);
  }
  const base = `FROM channels t LEFT JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT t.*, c.name AS category_name ${base} ORDER BY c.sort, t.number LIMIT ? OFFSET ?`).all(...params, Math.min(300, opts.limit ?? 100), opts.offset ?? 0);
  return { items: attachNowNext(db, rows.map(channelCard)), total };
}

/* ---------------- details (lazy provider enrichment) ---------------- */

const DETAILS_TTL = 7 * 86_400_000;

async function fetchProviderJson(db: DB, providerId: string, action: string, params: Record<string, string>): Promise<unknown | null> {
  const p = getProvider(db, providerId);
  if (!p || (p.is_https === 0 && p.http_consent === 0)) return null;
  const secret = getSecret(p);
  if (secret.type !== 'xtream') return null;
  try {
    const res = await upstreamFetch(xtreamUrls.api(secret, action, params), { timeoutMs: 15_000 });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    log.warn(`Provider ${action} failed`, err);
    return null;
  }
}

export async function movieDetails(db: DB, id: string) {
  let row = db.prepare('SELECT m.*, c.name AS category_name FROM movies m LEFT JOIN categories c ON c.id = m.category_id WHERE m.id = ?').get(id) as any;
  if (!row) return null;
  if (!row.details_at || Date.now() - row.details_at > DETAILS_TTL) {
    const json = await fetchProviderJson(db, row.provider_id, 'get_vod_info', { vod_id: row.source_id });
    if (json) {
      const d = parseVodInfo(json);
      db.prepare(
        `UPDATE movies SET plot = COALESCE(?, plot), genres = COALESCE(?, genres), cast_names = COALESCE(?, cast_names), director = COALESCE(?, director),
           runtime_min = COALESCE(?, runtime_min), backdrop = COALESCE(?, backdrop), trailer = COALESCE(?, trailer), details_json = ?, details_at = ? WHERE id = ?`,
      ).run(d.plot ?? null, d.genres ? JSON.stringify(d.genres) : null, d.cast ?? null, d.director ?? null, d.runtimeMin ?? null, d.backdrop ?? null, d.trailer ?? null, JSON.stringify(d), Date.now(), id);
      row = db.prepare('SELECT m.*, c.name AS category_name FROM movies m LEFT JOIN categories c ON c.id = m.category_id WHERE m.id = ?').get(id) as any;
    }
  }
  const details: MovieDetails = row.details_json ? JSON.parse(row.details_json) : {};
  const verified = db.prepare('SELECT width, height FROM verified_quality WHERE content_id = ?').get(id) as { width: number; height: number } | undefined;
  return {
    ...movieCard(row),
    plot: row.plot ?? undefined,
    genres: row.genres ? (JSON.parse(row.genres) as string[]) : undefined,
    cast: row.cast_names ?? undefined,
    director: row.director ?? undefined,
    runtimeMin: row.runtime_min ?? undefined,
    container: row.container ?? undefined,
    qualityHint: row.quality_hint ?? undefined,
    releaseDate: details.releaseDate,
    trailer: row.trailer ?? undefined,
    reported: { video: details.video, audio: details.audio },
    verified: verified ? { width: verified.width, height: verified.height } : undefined,
    providerId: row.provider_id,
    related: related(db, 'movie', row),
  };
}

export async function seriesDetails(db: DB, id: string) {
  let row = db.prepare('SELECT s.*, c.name AS category_name FROM series s LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = ?').get(id) as any;
  if (!row) return null;
  if (!row.details_at || Date.now() - row.details_at > DETAILS_TTL) {
    const json = await fetchProviderJson(db, row.provider_id, 'get_series_info', { series_id: row.source_id });
    if (json) {
      const d = parseSeriesInfo(row.provider_id, row.source_id, json);
      tx(db, () => {
        db.prepare('DELETE FROM episodes WHERE series_id = ?').run(id);
        const ins = db.prepare(
          `INSERT OR REPLACE INTO episodes (id, provider_id, series_id, source_id, season, episode, title, plot, thumb, runtime_sec, container, air_date, reported_height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        for (const e of d.episodes) {
          ins.run(e.id, e.providerId, id, e.sourceId, e.season, e.episode, e.title, e.plot ?? null, e.thumb ?? null, e.runtimeSec ?? null, e.container ?? null, e.airDate ?? null, e.reportedHeight ?? null);
        }
        db.prepare(
          `UPDATE series SET plot = COALESCE(?, plot), backdrop = COALESCE(?, backdrop), genres = COALESCE(?, genres), cast_names = COALESCE(?, cast_names), seasons_json = ?, details_at = ? WHERE id = ?`,
        ).run(d.plot ?? null, d.backdrop ?? null, d.genres ? JSON.stringify(d.genres) : null, d.cast ?? null, JSON.stringify(d.seasons), Date.now(), id);
      });
      row = db.prepare('SELECT s.*, c.name AS category_name FROM series s LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = ?').get(id) as any;
    }
  }
  const episodes = (db.prepare('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode').all(id) as any[]).map((e) => ({
    id: e.id,
    season: e.season,
    episode: e.episode,
    title: e.title,
    plot: e.plot ?? undefined,
    thumb: e.thumb ?? undefined,
    runtimeSec: e.runtime_sec ?? undefined,
    airDate: e.air_date ?? undefined,
    reportedHeight: e.reported_height ?? undefined,
  }));
  let seasons = row.seasons_json ? (JSON.parse(row.seasons_json) as Array<{ number: number; name: string; episodeCount: number; poster?: string }>) : [];
  if (!seasons.length && episodes.length) {
    const nums = Array.from(new Set(episodes.map((e) => e.season))).sort((x, y) => x - y);
    seasons = nums.map((n) => ({ number: n, name: n === 0 ? 'Specials' : `Season ${n}`, episodeCount: episodes.filter((e) => e.season === n).length }));
  }
  return {
    ...seriesCard(row),
    plot: row.plot ?? undefined,
    genres: row.genres ? (JSON.parse(row.genres) as string[]) : undefined,
    cast: row.cast_names ?? undefined,
    director: row.director ?? undefined,
    trailer: row.trailer ?? undefined,
    seasons,
    episodes,
    providerId: row.provider_id,
    related: related(db, 'series', row),
  };
}

function related(db: DB, kind: 'movie' | 'series', row: any): Card[] {
  const table = kind === 'movie' ? 'movies' : 'series';
  const rows = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM ${table} t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.category_id = ? AND t.id <> ? AND t.match_key <> ? AND t.is_adult = 0 AND t.poster IS NOT NULL
       GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT 18`,
    )
    .all(row.category_id, row.id, row.match_key);
  return rows.map(kind === 'movie' ? movieCard : seriesCard);
}

export function channelDetails(db: DB, id: string) {
  const row = db.prepare('SELECT t.*, c.name AS category_name FROM channels t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?').get(id) as any;
  if (!row) return null;
  const card = attachNowNext(db, [channelCard(row)])[0];
  // Same channel listed elsewhere (other categories, backup feeds) — used by stream recovery.
  const alternates = new Set<string>(row.alternates_json ? (JSON.parse(row.alternates_json) as string[]) : []);
  for (const r of db.prepare('SELECT id FROM channels WHERE provider_id = ? AND match_key = ? AND id <> ? LIMIT 8').all(row.provider_id, row.match_key, id) as Array<{ id: string }>) {
    alternates.add(r.id);
  }
  const alts = alternates.size
    ? (db.prepare(`SELECT t.id, t.name, c.name AS category_name FROM channels t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id IN (${[...alternates].map(() => '?').join(',')})`).all(...alternates) as any[])
    : [];
  return {
    ...card,
    epgId: row.epg_id ?? undefined,
    qualityHint: row.quality_hint ?? undefined,
    catchupDays: row.catchup_days ?? undefined,
    providerId: row.provider_id,
    alternates: alts.map((a) => ({ id: a.id, title: a.name, category: a.category_name ?? undefined })),
  };
}

/** Channels before/after this one in its category, for channel up/down. */
export function neighbourChannels(db: DB, id: string): { prevChannel?: string; nextChannel?: string } {
  const row = db.prepare('SELECT category_id, number FROM channels WHERE id = ?').get(id) as { category_id: string; number: number } | undefined;
  if (!row) return {};
  const prev = db.prepare('SELECT id FROM channels WHERE category_id = ? AND (number < ? OR (number = ? AND id < ?)) AND is_adult = 0 ORDER BY number DESC, id DESC LIMIT 1').get(row.category_id, row.number, row.number, id) as
    | { id: string }
    | undefined;
  const next = db.prepare('SELECT id FROM channels WHERE category_id = ? AND (number > ? OR (number = ? AND id > ?)) AND is_adult = 0 ORDER BY number, id LIMIT 1').get(row.category_id, row.number, row.number, id) as
    | { id: string }
    | undefined;
  return { prevChannel: prev?.id, nextChannel: next?.id };
}

/** Minimal metadata for any content id (used for continue watching, history, player titles). */
export function lookupCards(db: DB, ids: string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  const byKind: Record<string, string[]> = {};
  for (const id of ids) {
    const k = parseContentId(id)?.kind;
    if (k) (byKind[k] ??= []).push(id);
  }
  const ph = (n: number) => Array(n).fill('?').join(',');
  if (byKind.movie?.length)
    for (const r of db.prepare(`SELECT t.*, c.name AS category_name FROM movies t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id IN (${ph(byKind.movie.length)})`).all(...byKind.movie))
      out.set((r as any).id, movieCard(r));
  if (byKind.series?.length)
    for (const r of db.prepare(`SELECT t.*, c.name AS category_name FROM series t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id IN (${ph(byKind.series.length)})`).all(...byKind.series))
      out.set((r as any).id, seriesCard(r));
  if (byKind.live?.length)
    for (const r of db.prepare(`SELECT t.*, c.name AS category_name FROM channels t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id IN (${ph(byKind.live.length)})`).all(...byKind.live))
      out.set((r as any).id, channelCard(r));
  if (byKind.episode?.length)
    for (const r of db
      .prepare(
        `SELECT e.id, e.title, e.season, e.episode, e.thumb, e.series_id, s.title AS series_title, s.backdrop, s.poster FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id IN (${ph(byKind.episode.length)})`,
      )
      .all(...byKind.episode) as any[])
      out.set(r.id, {
        id: r.id,
        kind: 'episode',
        title: r.series_title,
        subtitle: `S${r.season} · E${r.episode} · ${r.title}`,
        backdrop: r.thumb ?? r.backdrop ?? undefined,
        poster: r.poster ?? undefined,
        seriesId: r.series_id,
      });
  return out;
}

/* ---------------- home ---------------- */

export interface HeroItem {
  id: string;
  kind: 'movie' | 'series';
  title: string;
  year?: number;
  plot?: string;
  genres?: string[];
  backdrop: string;
  poster?: string;
  runtimeMin?: number;
  rating?: number;
  category?: string;
}

/** Featured titles: recent, with real backdrop artwork and a synopsis. Never fabricated. */
export function heroItems(db: DB, a: Audience): HeroItem[] {
  const filt = audienceSql(a, 't');
  const series = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM series t LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${filt} AND t.backdrop IS NOT NULL AND t.plot IS NOT NULL AND length(t.plot) > 40 GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT 4`,
    )
    .all() as any[];
  const movies = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM movies t LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${filt} AND t.backdrop IS NOT NULL AND t.plot IS NOT NULL GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT 4`,
    )
    .all() as any[];
  const out: HeroItem[] = [];
  for (let i = 0; i < 4; i++) {
    for (const [r, kind] of [
      [movies[i], 'movie'],
      [series[i], 'series'],
    ] as const) {
      if (!r) continue;
      out.push({
        id: r.id,
        kind,
        title: r.title,
        year: r.year ?? undefined,
        plot: r.plot,
        genres: r.genres ? JSON.parse(r.genres) : undefined,
        backdrop: r.backdrop,
        poster: r.poster ?? undefined,
        runtimeMin: r.runtime_min ?? undefined,
        rating: r.rating ?? undefined,
        category: r.category_name ?? undefined,
      });
    }
  }
  return out.slice(0, 6);
}

/** Movies that should be enriched in the background so the hero has artwork. */
export function heroEnrichmentCandidates(db: DB, limit = 10): string[] {
  return (
    db
      .prepare(
        `SELECT t.id FROM movies t LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.is_adult = 0 AND c.region IS NULL AND t.details_at IS NULL AND t.tmdb_id IS NOT NULL
         GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>
  ).map((r) => r.id);
}

export function continueWatching(db: DB, profileId: string): Card[] {
  const rows = db
    .prepare(
      `SELECT content_id, kind, series_id, position_sec, duration_sec FROM progress
       WHERE profile_id = ? AND finished = 0 AND kind IN ('movie','episode') AND position_sec > 30 ORDER BY updated_at DESC LIMIT 40`,
    )
    .all(profileId) as Array<{ content_id: string; kind: string; series_id: string | null; position_sec: number; duration_sec: number }>;
  // One entry per series: the most recent episode.
  const seen = new Set<string>();
  const picked = rows.filter((r) => {
    const key = r.series_id ?? r.content_id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const cards = lookupCards(db, picked.map((r) => r.content_id));
  const out: Card[] = [];
  for (const r of picked) {
    const c = cards.get(r.content_id);
    if (c) out.push({ ...c, progress: { position: r.position_sec, duration: r.duration_sec } });
  }
  return out.slice(0, 20);
}

export function recentChannels(db: DB, profileId: string, limit = 20): Card[] {
  const ids = (
    db.prepare(`SELECT content_id, MAX(watched_at) AS at FROM history WHERE profile_id = ? AND kind = 'live' GROUP BY content_id ORDER BY at DESC LIMIT ?`).all(profileId, limit) as Array<{
      content_id: string;
    }>
  ).map((r) => r.content_id);
  const cards = lookupCards(db, ids);
  return attachNowNext(db, ids.map((id) => cards.get(id)).filter((c): c is Card => !!c));
}

export function myList(db: DB, profileId: string): Card[] {
  const favs = db.prepare('SELECT content_id FROM favorites WHERE profile_id = ? ORDER BY added_at DESC').all(profileId) as Array<{ content_id: string }>;
  const cards = lookupCards(db, favs.map((f) => f.content_id));
  return attachNowNext(db, favs.map((f) => cards.get(f.content_id)).filter((c): c is Card => !!c));
}

function genreRow(db: DB, a: Audience, kind: 'movie' | 'series', genre: string, limit = 24): Card[] {
  const table = kind === 'movie' ? 'movies' : 'series';
  const rows = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM ${table} t JOIN categories c ON c.id = t.category_id
       WHERE ${audienceSql(a, 't')} AND c.genre = ? AND t.poster IS NOT NULL GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT ?`,
    )
    .all(genre, limit);
  return rows.map(kind === 'movie' ? movieCard : seriesCard);
}

function liveGenreRow(db: DB, a: Audience, genre: string, limit = 20): Card[] {
  // Prefer channels that have guide data and a logo: they make a useful row.
  const rows = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM channels t JOIN categories c ON c.id = t.category_id
       WHERE ${audienceSql(a, 't', { regions: false })} AND c.genre = ? AND t.logo IS NOT NULL AND t.epg_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM programmes p WHERE p.provider_id = t.provider_id AND p.channel_epg_id = t.epg_id AND p.start <= ? AND p.stop > ?)
       GROUP BY t.match_key ORDER BY c.sort, t.number LIMIT ?`,
    )
    .all(genre, Date.now(), Date.now(), limit);
  return attachNowNext(db, rows.map(channelCard));
}

export function homeRows(db: DB, profileId: string, a: Audience, recCandidates: () => Card[]): Row[] {
  const rows: Row[] = [];
  // A title appears in at most one discovery row so Home doesn't repeat itself.
  const used = new Set<string>();
  const push = (r: Row) => {
    const personal = r.id === 'continue' || r.id === 'my-list' || r.layout === 'channel';
    const items = personal ? r.items : r.items.filter((c) => !used.has(c.id));
    if (!personal) items.forEach((c) => used.add(c.id));
    if (items.length >= (personal ? 1 : 4)) rows.push({ ...r, items: items.slice(0, 20) });
  };
  push({ id: 'continue', title: 'Continue Watching', layout: 'continue', items: continueWatching(db, profileId) });
  push({ id: 'recommended', title: 'Recommended for You', layout: 'poster', items: recommendFor(db, profileId, recCandidates()) });
  const filt = audienceSql(a, 't');
  push({
    id: 'recent-movies',
    title: 'Recently Added Movies',
    layout: 'poster',
    href: '/movies',
    items: (
      db.prepare(`SELECT t.*, c.name AS category_name FROM movies t LEFT JOIN categories c ON c.id = t.category_id WHERE ${filt} AND t.poster IS NOT NULL GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT 24`).all() as any[]
    ).map(movieCard),
  });
  push({
    id: 'new-series',
    title: 'New Episodes & Series',
    layout: 'landscape',
    href: '/shows',
    items: (
      db
        .prepare(`SELECT t.*, c.name AS category_name FROM series t LEFT JOIN categories c ON c.id = t.category_id WHERE ${filt} AND t.backdrop IS NOT NULL GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT 20`)
        .all() as any[]
    ).map(seriesCard),
  });
  push({
    id: 'top-series',
    title: 'Highly Rated Series',
    layout: 'poster',
    note: 'Ratings supplied by your provider',
    href: '/shows?sort=rating',
    items: (
      db
        .prepare(
          `SELECT t.*, c.name AS category_name FROM series t LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${filt} AND t.poster IS NOT NULL AND t.rating >= 7 AND t.added_at > ? GROUP BY t.match_key ORDER BY t.rating DESC, t.added_at DESC LIMIT 24`,
        )
        .all(Date.now() - 365 * 86_400_000) as any[]
    ).map(seriesCard),
  });
  push({ id: 'live-sports', title: 'Live Sports', layout: 'channel', href: '/live?genre=sports', items: liveGenreRow(db, a, 'sports') });
  push({ id: 'recent-channels', title: 'Recently Watched Channels', layout: 'channel', href: '/live', items: recentChannels(db, profileId) });
  for (const [genre, kind] of [
    ['action', 'movie'],
    ['comedy', 'movie'],
    ['scifi', 'movie'],
    ['documentary', 'movie'],
    ['crime', 'series'],
  ] as const) {
    push({
      id: `genre-${kind}-${genre}`,
      title: kind === 'series' ? `${GENRE_LABELS[genre]} Series` : GENRE_LABELS[genre],
      layout: 'poster',
      href: `/${kind === 'movie' ? 'movies' : 'shows'}?genre=${genre}`,
      items: genreRow(db, a, kind, genre, 44),
    });
  }
  push({ id: 'live-news', title: 'News Channels', layout: 'channel', href: '/live?genre=news', items: liveGenreRow(db, a, 'news') });
  push({ id: 'my-list', title: 'My List', layout: 'poster', href: '/my-list', items: myList(db, profileId).filter((c) => c.kind !== 'live') });
  return rows;
}

/* ---------------- recommendations ---------------- */

export function recommendFor(db: DB, profileId: string, candidates: Card[]): Card[] {
  const history = (db.prepare('SELECT content_id, kind, category_id, genres, completion, watched_at FROM history WHERE profile_id = ? AND kind <> ? ORDER BY watched_at DESC LIMIT 300').all(profileId, 'live') as any[]).map(
    (h) => ({
      contentId: h.content_id,
      kind: h.kind,
      categoryId: h.category_id ?? undefined,
      genres: h.genres ? (JSON.parse(h.genres) as string[]) : undefined,
      completion: h.completion,
      watchedAt: h.watched_at,
    }),
  );
  if (!history.length) return [];
  const resetAt = (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`recs_reset:${profileId}`) as { value: string } | undefined)?.value;
  const effective = resetAt ? history.filter((h) => h.watchedAt > Number(resetAt)) : history;
  if (!effective.length) return [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const recs = recommend(
    candidates.map((c) => ({ id: c.id, kind: c.kind as 'movie' | 'series', title: c.title, categoryId: c.categoryId, rating: c.rating, addedAt: c.addedAt, genres: c.category ? [c.category] : undefined })),
    effective.map((h) => ({ ...h, genres: h.genres ?? (h.categoryId ? categoryName(db, h.categoryId) : undefined) })),
    { limit: 24 },
  );
  return recs.map((r) => ({ ...byId.get(r.id)!, reason: r.reason })).filter((c) => c.id);
}

const catNameCache = new Map<string, string[] | undefined>();
function categoryName(db: DB, id: string): string[] | undefined {
  if (!catNameCache.has(id)) {
    const r = db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string } | undefined;
    catNameCache.set(id, r ? [r.name] : undefined);
  }
  return catNameCache.get(id);
}

/** Recent, artwork-bearing titles from the account's sources: the candidate pool for recommendations. */
export function recommendationPool(db: DB, providers: string[]): Card[] {
  const own = providerSql({ providers }, 't');
  const movies = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM movies t LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${own} AND t.is_adult = 0 AND c.region IS NULL AND t.poster IS NOT NULL GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT 1500`,
    )
    .all() as any[];
  const series = db
    .prepare(
      `SELECT t.*, c.name AS category_name FROM series t LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${own} AND t.is_adult = 0 AND t.poster IS NOT NULL GROUP BY t.match_key ORDER BY t.added_at DESC LIMIT 800`,
    )
    .all() as any[];
  return [...movies.map(movieCard), ...series.map(seriesCard)];
}

/* ---------------- search ---------------- */

export class CatalogSearch {
  index = new SearchIndex();
  builtAt = 0;

  rebuild(db: DB): void {
    const started = Date.now();
    const docs: SearchDoc[] = [];
    for (const r of db.prepare(`SELECT t.id, t.title, t.year, t.is_adult, t.cast_names, c.name AS cat, c.is_adult AS cat_adult FROM movies t LEFT JOIN categories c ON c.id = t.category_id`).all() as any[]) {
      docs.push({ id: r.id, kind: 'movie', title: r.title, extra: [r.year, r.cast_names, r.cat].filter(Boolean).join(' '), isAdult: !!(r.is_adult || r.cat_adult) });
    }
    for (const r of db.prepare(`SELECT t.id, t.title, t.year, t.is_adult, t.cast_names, t.genres, c.name AS cat, c.is_adult AS cat_adult FROM series t LEFT JOIN categories c ON c.id = t.category_id`).all() as any[]) {
      docs.push({ id: r.id, kind: 'series', title: r.title, extra: [r.year, r.cast_names, r.genres, r.cat].filter(Boolean).join(' '), isAdult: !!(r.is_adult || r.cat_adult) });
    }
    for (const r of db.prepare(`SELECT t.id, t.name, t.is_adult, c.name AS cat, c.is_adult AS cat_adult FROM channels t LEFT JOIN categories c ON c.id = t.category_id`).all() as any[]) {
      docs.push({ id: r.id, kind: 'live', title: r.name, extra: r.cat ?? '', isAdult: !!(r.is_adult || r.cat_adult) });
    }
    for (const r of db.prepare(`SELECT id, name, kind, is_adult FROM categories WHERE item_count > 0`).all() as any[]) {
      docs.push({ id: r.id, kind: 'category', title: r.name, extra: r.kind, isAdult: !!r.is_adult });
    }
    this.index.replace(docs);
    this.builtAt = Date.now();
    log.info(`Search index: ${docs.length.toLocaleString()} documents in ${Date.now() - started} ms`);
  }
}
