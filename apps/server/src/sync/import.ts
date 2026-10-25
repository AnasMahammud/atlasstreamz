import {
  M3UCatalogBuilder,
  M3UStreamParser,
  XmltvStreamParser,
  normalizeCategories,
  normalizeLiveStreams,
  normalizeSeriesList,
  normalizeVodStreams,
  parseAccountInfo,
  xtreamUrls,
  type Category,
  type Episode,
  type LiveChannel,
  type Movie,
  type Series,
} from '@atlas/core';
import type { DB } from '../db.ts';
import { tx } from '../db.ts';
import { config } from '../config.ts';
import { getProvider, getSecret, upstreamFetch, type ProviderSecret } from '../providers.ts';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'network' | 'invalid' | 'consent' | 'http',
  ) {
    super(message);
  }
}

export type Progress = (stage: string, detail?: string) => void;

export interface CatalogPayload {
  categories: Category[];
  channels: Array<{ item: LiveChannel; url?: string; options?: Record<string, string>; alternates?: string[] }>;
  movies: Array<{ item: Movie; url?: string }>;
  series: Series[];
  /** Only for plain M3U providers; Xtream episodes are fetched on demand. */
  episodes?: Array<{ item: Episode; url?: string }>;
}

export interface SyncSummary {
  channels: number;
  movies: number;
  series: number;
  episodes: number;
  categories: number;
  added: { channels: number; movies: number; series: number };
  removed: { channels: number; movies: number; series: number };
  renamedChannels: number;
  rematchedUserItems: number;
  epgProgrammes: number;
  epgChannels: number;
  epgError?: string;
  durationMs: number;
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await upstreamFetch(url, { timeoutMs: 90_000 });
  } catch (err) {
    throw new SyncError(`Could not download ${label}: ${err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error'}.`, 'network');
  }
  if (!res.ok) throw new SyncError(`Provider returned HTTP ${res.status} for ${label}.`, 'http');
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SyncError(`Provider returned invalid data for ${label}.`, 'invalid');
  }
}

/** Stream a text body through `push` without buffering it whole. */
async function streamText(url: string, push: (s: string) => void, label: string): Promise<void> {
  let res: Response;
  try {
    res = await upstreamFetch(url, { timeoutMs: 10 * 60_000 });
  } catch {
    throw new SyncError(`Could not download ${label}.`, 'network');
  }
  if (!res.ok || !res.body) throw new SyncError(`Provider returned HTTP ${res.status} for ${label}.`, 'http');
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) push(decoder.decode(chunk, { stream: true }));
  push(decoder.decode());
}

export async function runProviderSync(db: DB, providerId: string, runId: number, progress: Progress): Promise<SyncSummary> {
  const started = Date.now();
  const row = getProvider(db, providerId);
  if (!row) throw new SyncError('Provider no longer exists.', 'invalid');
  if (row.is_https === 0 && row.http_consent === 0) {
    throw new SyncError('This provider uses unencrypted HTTP. Allow it in Settings → Content Sources first.', 'consent');
  }
  const secret = getSecret(row);

  let payload: CatalogPayload;
  let epgUrl: string | undefined = secret.epgUrl;
  if (secret.type === 'xtream') {
    progress('account', 'Checking account');
    const account = parseAccountInfo(await fetchJson(xtreamUrls.api(secret), 'account info'));
    db.prepare('UPDATE providers SET account_json = ? WHERE id = ?').run(JSON.stringify(account), providerId);
    if (!account.auth) throw new SyncError('The provider rejected the saved credentials.', 'auth');
    if (account.expiresAt && account.expiresAt < Date.now()) throw new SyncError('The provider account has expired.', 'auth');
    payload = await fetchXtream(providerId, secret, progress);
    epgUrl ??= xtreamUrls.xmltv(secret);
  } else {
    const result = await fetchM3U(providerId, secret, progress);
    payload = result.payload;
    epgUrl ??= result.epgUrl;
  }

  if (payload.channels.length + payload.movies.length + payload.series.length === 0) {
    // Never replace a working catalogue with an empty one.
    throw new SyncError('The provider returned an empty catalogue. Keeping the previous one.', 'invalid');
  }

  progress('saving', 'Saving catalogue');
  const summary = writeCatalog(db, providerId, runId, payload);

  if (epgUrl) {
    progress('epg', 'Downloading programme guide');
    try {
      const epg = await importEpg(db, providerId, epgUrl);
      summary.epgProgrammes = epg.programmes;
      summary.epgChannels = epg.channels;
    } catch (err) {
      // A guide failure must not fail the catalogue sync; keep the old guide.
      summary.epgError = err instanceof Error ? err.message : 'Guide download failed.';
    }
  }
  summary.durationMs = Date.now() - started;
  return summary;
}

async function fetchXtream(providerId: string, c: Extract<ProviderSecret, { type: 'xtream' }>, progress: Progress): Promise<CatalogPayload> {
  progress('categories', 'Fetching categories');
  const [liveCats, vodCats, seriesCats] = await Promise.all([
    fetchJson(xtreamUrls.api(c, 'get_live_categories'), 'live categories'),
    fetchJson(xtreamUrls.api(c, 'get_vod_categories'), 'movie categories'),
    fetchJson(xtreamUrls.api(c, 'get_series_categories'), 'series categories'),
  ]);
  progress('live', 'Fetching live channels');
  const live = normalizeLiveStreams(providerId, await fetchJson(xtreamUrls.api(c, 'get_live_streams'), 'live channels'));
  progress('movies', 'Fetching movies');
  const movies = normalizeVodStreams(providerId, await fetchJson(xtreamUrls.api(c, 'get_vod_streams'), 'movies'));
  progress('series', 'Fetching series');
  const series = normalizeSeriesList(providerId, await fetchJson(xtreamUrls.api(c, 'get_series'), 'series'));
  return {
    categories: [
      ...normalizeCategories(providerId, 'live', liveCats),
      ...normalizeCategories(providerId, 'movie', vodCats),
      ...normalizeCategories(providerId, 'series', seriesCats),
    ],
    channels: live.map((item) => ({ item })),
    movies: movies.map((item) => ({ item })),
    series,
  };
}

async function fetchM3U(providerId: string, secret: Extract<ProviderSecret, { type: 'm3u' }>, progress: Progress) {
  progress('playlist', 'Downloading playlist');
  const builder = new M3UCatalogBuilder(providerId);
  const parser = new M3UStreamParser((e) => builder.add(e));
  let sawHeader = false;
  let first = true;
  await streamText(
    secret.url,
    (s) => {
      if (first && s.trim()) {
        first = false;
        sawHeader = /^﻿?\s*#EXTM3U/i.test(s);
        if (!sawHeader && !/#EXTINF/i.test(s.slice(0, 4096))) throw new SyncError('The URL did not return an M3U playlist.', 'invalid');
      }
      parser.push(s);
    },
    'playlist',
  );
  parser.end();
  progress('parsing', `Parsed ${parser.count.toLocaleString()} entries`);
  const cat = builder.build();
  return {
    epgUrl: parser.header.epgUrls[0],
    payload: {
      categories: cat.categories,
      channels: cat.channels.map((c) => ({ ...c, alternates: cat.alternates.get(c.item.id) })),
      movies: cat.movies,
      series: cat.series,
      episodes: cat.episodes,
    } satisfies CatalogPayload,
  };
}

/**
 * Apply a full catalogue atomically: upsert everything tagged with this run, delete what the
 * provider no longer lists, then re-attach favourites/progress whose IDs changed.
 */
export function writeCatalog(db: DB, providerId: string, runId: number, p: CatalogPayload): SyncSummary {
  const existing = (table: string) =>
    new Map((db.prepare(`SELECT id, ${table === 'channels' ? 'name' : 'title'} AS label FROM ${table} WHERE provider_id = ?`).all(providerId) as Array<{ id: string; label: string }>).map((r) => [r.id, r.label]));
  const before = { channels: existing('channels'), movies: existing('movies'), series: existing('series') };

  const summary: SyncSummary = {
    channels: p.channels.length,
    movies: p.movies.length,
    series: p.series.length,
    episodes: p.episodes?.length ?? 0,
    categories: p.categories.length,
    added: { channels: 0, movies: 0, series: 0 },
    removed: { channels: 0, movies: 0, series: 0 },
    renamedChannels: 0,
    rematchedUserItems: 0,
    epgProgrammes: 0,
    epgChannels: 0,
    durationMs: 0,
  };
  for (const c of p.channels) {
    const prev = before.channels.get(c.item.id);
    if (prev === undefined) summary.added.channels++;
    else if (prev !== c.item.name) summary.renamedChannels++;
  }
  summary.added.movies = p.movies.filter((m) => !before.movies.has(m.item.id)).length;
  summary.added.series = p.series.filter((s) => !before.series.has(s.id)).length;
  const now = new Set([...p.channels.map((c) => c.item.id), ...p.movies.map((m) => m.item.id), ...p.series.map((s) => s.id)]);
  summary.removed.channels = [...before.channels.keys()].filter((id) => !now.has(id)).length;
  summary.removed.movies = [...before.movies.keys()].filter((id) => !now.has(id)).length;
  summary.removed.series = [...before.series.keys()].filter((id) => !now.has(id)).length;

  tx(db, () => {
    const cat = db.prepare(
      `INSERT INTO categories (id, provider_id, kind, source_id, name, genre, region, is_adult, sort, seen_run) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, genre=excluded.genre, region=excluded.region, is_adult=excluded.is_adult, sort=excluded.sort, seen_run=excluded.seen_run`,
    );
    for (const c of p.categories) cat.run(c.id, providerId, c.kind, c.sourceId, c.name, c.genre ?? null, c.region ?? null, c.isAdult ? 1 : 0, c.sort, runId);

    const ch = db.prepare(
      `INSERT INTO channels (id, provider_id, source_id, name, logo, category_id, number, epg_id, catchup_days, quality_hint, region, is_adult, match_key, added_at, url, options_json, alternates_json, seen_run)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, logo=excluded.logo, category_id=excluded.category_id, number=excluded.number, epg_id=excluded.epg_id,
         catchup_days=excluded.catchup_days, quality_hint=excluded.quality_hint, region=excluded.region, is_adult=excluded.is_adult, match_key=excluded.match_key,
         added_at=excluded.added_at, url=excluded.url, options_json=excluded.options_json, alternates_json=excluded.alternates_json, seen_run=excluded.seen_run`,
    );
    for (const { item: c, url, options, alternates } of p.channels) {
      ch.run(
        c.id, providerId, c.sourceId, c.name, c.logo ?? null, c.categoryId ?? null, c.number ?? null, c.epgId ?? null, c.catchupDays ?? null,
        c.qualityHint ?? null, c.region ?? null, c.isAdult ? 1 : 0, c.matchKey, c.addedAt ?? null, url ?? null,
        options ? JSON.stringify(options) : null, alternates?.length ? JSON.stringify(alternates) : null, runId,
      );
    }

    // Provider lists don't carry details; keep previously fetched details unless the list now has them.
    const mv = db.prepare(
      `INSERT INTO movies (id, provider_id, source_id, title, year, poster, rating, tmdb_id, trailer, category_id, container, quality_hint, region, is_adult, added_at, match_key, url, seen_run)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, year=excluded.year, poster=COALESCE(excluded.poster, movies.poster), rating=excluded.rating,
         tmdb_id=excluded.tmdb_id, trailer=COALESCE(excluded.trailer, movies.trailer), category_id=excluded.category_id, container=excluded.container,
         quality_hint=excluded.quality_hint, region=excluded.region, is_adult=excluded.is_adult, added_at=excluded.added_at, match_key=excluded.match_key,
         url=excluded.url, seen_run=excluded.seen_run`,
    );
    for (const { item: m, url } of p.movies) {
      mv.run(
        m.id, providerId, m.sourceId, m.title, m.year ?? null, m.poster ?? null, m.rating ?? null, m.tmdbId ?? null, m.trailer ?? null,
        m.categoryId ?? null, m.container ?? null, m.qualityHint ?? null, m.region ?? null, m.isAdult ? 1 : 0, m.addedAt ?? null, m.matchKey, url ?? null, runId,
      );
    }

    const se = db.prepare(
      `INSERT INTO series (id, provider_id, source_id, title, year, poster, backdrop, plot, genres, cast_names, director, rating, tmdb_id, trailer, category_id, region, is_adult, added_at, match_key, seen_run)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, year=excluded.year, poster=COALESCE(excluded.poster, series.poster), backdrop=COALESCE(excluded.backdrop, series.backdrop),
         plot=COALESCE(excluded.plot, series.plot), genres=COALESCE(excluded.genres, series.genres), cast_names=COALESCE(excluded.cast_names, series.cast_names),
         director=COALESCE(excluded.director, series.director), rating=excluded.rating, tmdb_id=excluded.tmdb_id, trailer=COALESCE(excluded.trailer, series.trailer),
         category_id=excluded.category_id, region=excluded.region, is_adult=excluded.is_adult,
         details_at=CASE WHEN excluded.added_at IS NOT series.added_at THEN NULL ELSE series.details_at END,
         added_at=excluded.added_at, match_key=excluded.match_key, seen_run=excluded.seen_run`,
    );
    for (const s of p.series) {
      se.run(
        s.id, providerId, s.sourceId, s.title, s.year ?? null, s.poster ?? null, s.backdrop ?? null, s.plot ?? null, s.genres ? JSON.stringify(s.genres) : null,
        s.cast ?? null, s.director ?? null, s.rating ?? null, s.tmdbId ?? null, s.trailer ?? null, s.categoryId ?? null, s.region ?? null, s.isAdult ? 1 : 0,
        s.addedAt ?? null, s.matchKey, runId,
      );
    }

    if (p.episodes) {
      db.prepare('DELETE FROM episodes WHERE provider_id = ?').run(providerId);
      const ep = db.prepare(
        `INSERT OR REPLACE INTO episodes (id, provider_id, series_id, source_id, season, episode, title, plot, thumb, runtime_sec, container, air_date, reported_height, url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const { item: e, url } of p.episodes) {
        ep.run(e.id, providerId, e.seriesId, e.sourceId, e.season, e.episode, e.title, e.plot ?? null, e.thumb ?? null, e.runtimeSec ?? null, e.container ?? null, e.airDate ?? null, e.reportedHeight ?? null, url ?? null);
      }
      db.prepare(`UPDATE series SET details_at = ? WHERE provider_id = ?`).run(Date.now(), providerId);
    }

    for (const table of ['categories', 'channels', 'movies', 'series']) {
      db.prepare(`DELETE FROM ${table} WHERE provider_id = ? AND seen_run <> ?`).run(providerId, runId);
    }
    db.prepare(`DELETE FROM episodes WHERE provider_id = ? AND series_id NOT IN (SELECT id FROM series WHERE provider_id = ?)`).run(providerId, providerId);

    db.prepare(
      `UPDATE categories SET item_count = CASE kind
         WHEN 'live' THEN (SELECT COUNT(*) FROM channels WHERE category_id = categories.id)
         WHEN 'movie' THEN (SELECT COUNT(*) FROM movies WHERE category_id = categories.id)
         ELSE (SELECT COUNT(*) FROM series WHERE category_id = categories.id) END
       WHERE provider_id = ?`,
    ).run(providerId);

    summary.rematchedUserItems = rematchUserData(db, providerId);
  });
  return summary;
}

/**
 * Favourites and progress point at content IDs. If a provider re-issued an ID, find the
 * same title by its match key and move the user's data over instead of losing it.
 */
function rematchUserData(db: DB, providerId: string): number {
  let moved = 0;
  const tables: Array<['favorites' | 'progress', string]> = [
    ['favorites', 'kind'],
    ['progress', 'kind'],
  ];
  for (const [table] of tables) {
    const orphans = db
      .prepare(
        `SELECT t.profile_id, t.content_id, t.kind, t.match_key FROM ${table} t
         WHERE t.content_id LIKE ? AND t.match_key IS NOT NULL AND t.kind IN ('live','movie','series')
           AND NOT EXISTS (SELECT 1 FROM channels WHERE id = t.content_id)
           AND NOT EXISTS (SELECT 1 FROM movies WHERE id = t.content_id)
           AND NOT EXISTS (SELECT 1 FROM series WHERE id = t.content_id)`,
      )
      .all(`${providerId}:%`) as Array<{ profile_id: string; content_id: string; kind: string; match_key: string }>;
    for (const o of orphans) {
      const target = o.kind === 'live' ? 'channels' : o.kind === 'movie' ? 'movies' : 'series';
      const hit = db.prepare(`SELECT id FROM ${target} WHERE provider_id = ? AND match_key = ? LIMIT 1`).get(providerId, o.match_key) as { id: string } | undefined;
      if (!hit) continue;
      db.prepare(`UPDATE OR IGNORE ${table} SET content_id = ? WHERE profile_id = ? AND content_id = ?`).run(hit.id, o.profile_id, o.content_id);
      moved++;
    }
  }
  return moved;
}

/** Download the XMLTV guide and replace this provider's programmes inside the EPG window. */
export async function importEpg(db: DB, providerId: string, url: string): Promise<{ programmes: number; channels: number }> {
  const wanted = new Set(
    (db.prepare('SELECT DISTINCT epg_id FROM channels WHERE provider_id = ? AND epg_id IS NOT NULL').all(providerId) as Array<{ epg_id: string }>).map((r) => r.epg_id),
  );
  // Some providers use different casing between the guide and the channel list.
  const lower = new Map([...wanted].map((id) => [id.toLowerCase(), id]));
  const nowMs = Date.now();
  const rows: Array<[string, number, number, string, string | null, string | null]> = [];
  const chans = new Set<string>();
  const parser = new XmltvStreamParser({
    windowStart: nowMs - config.epgPastMs,
    windowEnd: nowMs + config.epgFutureMs,
    channelFilter: (id) => wanted.has(id) || lower.has(id.toLowerCase()),
    onProgramme: (pr) => {
      const id = wanted.has(pr.channelEpgId) ? pr.channelEpgId : lower.get(pr.channelEpgId.toLowerCase())!;
      chans.add(id);
      rows.push([id, pr.start, pr.stop, pr.title.slice(0, 300), pr.desc?.slice(0, 1200) ?? null, pr.category?.slice(0, 80) ?? null]);
    },
  });
  await streamText(url, (s) => parser.push(s), 'programme guide');
  parser.end();
  if (rows.length === 0 && wanted.size > 0) throw new SyncError('The guide had no programmes for this provider’s channels.', 'invalid');
  tx(db, () => {
    db.prepare('DELETE FROM programmes WHERE provider_id = ?').run(providerId);
    const ins = db.prepare('INSERT INTO programmes (provider_id, channel_epg_id, start, stop, title, descr, category) VALUES (?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(providerId, ...r);
  });
  return { programmes: rows.length, channels: chans.size };
}
