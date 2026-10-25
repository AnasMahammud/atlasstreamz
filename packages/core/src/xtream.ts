import type { Category, CatalogKind, Episode, LiveChannel, Movie, Season, Series } from './models.ts';
import { contentId } from './ids.ts';
import { cleanChannelName, cleanTitle, genreFromName, looksAdult, matchKey, splitGenres, splitRegion } from './normalize.ts';

/** Xtream Codes–compatible account. The password never leaves the server process. */
export interface XtreamCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * Recognise a `get.php?username=…&password=…` playlist URL and recover the panel
 * credentials, so a plain M3U link from an Xtream panel can use the richer API.
 */
export function xtreamFromPlaylistUrl(url: string): XtreamCredentials | null {
  try {
    const u = new URL(url);
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (!username || !password) return null;
    if (!/\/(get|player_api)\.php$/i.test(u.pathname)) return null;
    const basePath = u.pathname.replace(/\/[^/]*$/, '');
    return { baseUrl: `${u.protocol}//${u.host}${basePath}`, username, password };
  } catch {
    return null;
  }
}

export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/(player_api|get)\.php$/i, '').replace(/\/+$/, '')}`;
}

const enc = encodeURIComponent;

export const xtreamUrls = {
  api(c: XtreamCredentials, action?: string, params: Record<string, string | number> = {}): string {
    const q = new URLSearchParams({ username: c.username, password: c.password });
    if (action) q.set('action', action);
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return `${c.baseUrl}/player_api.php?${q}`;
  },
  xmltv(c: XtreamCredentials): string {
    return `${c.baseUrl}/xmltv.php?username=${enc(c.username)}&password=${enc(c.password)}`;
  },
  live(c: XtreamCredentials, streamId: string | number, ext: 'm3u8' | 'ts' = 'm3u8'): string {
    return `${c.baseUrl}/live/${enc(c.username)}/${enc(c.password)}/${streamId}.${ext}`;
  },
  movie(c: XtreamCredentials, streamId: string | number, ext = 'mp4'): string {
    return `${c.baseUrl}/movie/${enc(c.username)}/${enc(c.password)}/${streamId}.${ext}`;
  },
  episode(c: XtreamCredentials, episodeId: string | number, ext = 'mp4'): string {
    return `${c.baseUrl}/series/${enc(c.username)}/${enc(c.password)}/${episodeId}.${ext}`;
  },
};

export interface XtreamAccountInfo {
  auth: boolean;
  status?: string;
  expiresAt?: number;
  isTrial?: boolean;
  activeConnections?: number;
  maxConnections?: number;
  outputFormats: string[];
  serverTimezone?: string;
  serverProtocol?: string;
  httpsPort?: number;
}

export function parseAccountInfo(json: unknown): XtreamAccountInfo {
  const d = (json ?? {}) as Record<string, any>;
  const u = d.user_info ?? {};
  const s = d.server_info ?? {};
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
  const exp = num(u.exp_date);
  return {
    auth: Number(u.auth) === 1,
    status: u.status ?? undefined,
    expiresAt: exp && Number.isFinite(exp) ? exp * 1000 : undefined,
    isTrial: u.is_trial !== undefined ? String(u.is_trial) === '1' : undefined,
    activeConnections: num(u.active_cons),
    maxConnections: num(u.max_connections),
    outputFormats: Array.isArray(u.allowed_output_formats) ? u.allowed_output_formats.map(String) : [],
    serverTimezone: s.timezone ?? undefined,
    serverProtocol: s.server_protocol ?? undefined,
    httpsPort: num(s.https_port),
  };
}

const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
};
const posNum = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const epochMs = (v: unknown): number | undefined => {
  const n = posNum(v);
  return n ? (n < 1e12 ? n * 1000 : n) : undefined;
};
const httpUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : undefined;
};

export function normalizeCategories(providerId: string, kind: CatalogKind, json: unknown): Category[] {
  if (!Array.isArray(json)) return [];
  return json.map((c: any, i: number) => {
    const name = str(c.category_name) ?? `Category ${i + 1}`;
    const { region } = splitRegion(name);
    return {
      id: contentId(providerId, 'category', `${kind}-${c.category_id}`),
      providerId,
      kind,
      sourceId: String(c.category_id),
      name,
      genre: genreFromName(name),
      region,
      isAdult: looksAdult(name),
      sort: i,
    };
  });
}

function categoryRef(providerId: string, kind: CatalogKind, categoryId: unknown): string | undefined {
  const id = str(categoryId);
  return id ? contentId(providerId, 'category', `${kind}-${id}`) : undefined;
}

export function normalizeLiveStreams(providerId: string, json: unknown): LiveChannel[] {
  if (!Array.isArray(json)) return [];
  const out: LiveChannel[] = [];
  for (const s of json as any[]) {
    if (s?.stream_id === undefined || s?.stream_id === null) continue;
    const rawName = str(s.name) ?? `Channel ${s.stream_id}`;
    const clean = cleanChannelName(rawName);
    out.push({
      id: contentId(providerId, 'live', s.stream_id),
      providerId,
      sourceId: String(s.stream_id),
      name: clean.title,
      logo: httpUrl(s.stream_icon),
      categoryId: categoryRef(providerId, 'live', s.category_id),
      number: posNum(s.num),
      epgId: str(s.epg_channel_id),
      catchupDays: Number(s.tv_archive) === 1 ? posNum(s.tv_archive_duration) : undefined,
      qualityHint: clean.qualityHint,
      region: clean.region,
      isAdult: Number(s.is_adult) === 1 || looksAdult(rawName),
      matchKey: matchKey('live', clean.title),
      addedAt: epochMs(s.added),
    });
  }
  return out;
}

export function normalizeVodStreams(providerId: string, json: unknown): Movie[] {
  if (!Array.isArray(json)) return [];
  const out: Movie[] = [];
  for (const s of json as any[]) {
    if (s?.stream_id === undefined || s?.stream_id === null) continue;
    const rawName = str(s.name) ?? `Movie ${s.stream_id}`;
    const clean = cleanTitle(rawName);
    const rating = Number(s.rating);
    out.push({
      id: contentId(providerId, 'movie', s.stream_id),
      providerId,
      sourceId: String(s.stream_id),
      title: clean.title,
      year: clean.year,
      poster: httpUrl(s.stream_icon),
      rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : undefined,
      tmdbId: str(s.tmdb),
      trailer: str(s.trailer),
      categoryId: categoryRef(providerId, 'movie', s.category_id),
      container: str(s.container_extension)?.toLowerCase(),
      qualityHint: clean.qualityHint,
      region: clean.region,
      isAdult: Number(s.is_adult) === 1 || looksAdult(rawName),
      addedAt: epochMs(s.added),
      matchKey: matchKey('movie', clean.title, clean.year),
    });
  }
  return out;
}

export function normalizeSeriesList(providerId: string, json: unknown): Series[] {
  if (!Array.isArray(json)) return [];
  const out: Series[] = [];
  for (const s of json as any[]) {
    if (s?.series_id === undefined || s?.series_id === null) continue;
    const rawName = str(s.name) ?? `Series ${s.series_id}`;
    const clean = cleanTitle(rawName);
    const release = str(s.releaseDate) ?? str(s.release_date);
    const year = clean.year ?? (release && /^\d{4}/.test(release) ? Number(release.slice(0, 4)) : undefined);
    const backdrops = Array.isArray(s.backdrop_path) ? s.backdrop_path : [s.backdrop_path];
    const rating = Number(s.rating);
    out.push({
      id: contentId(providerId, 'series', s.series_id),
      providerId,
      sourceId: String(s.series_id),
      title: clean.title,
      year,
      poster: httpUrl(s.cover),
      backdrop: backdrops.map(httpUrl).find(Boolean),
      plot: str(s.plot),
      genres: splitGenres(s.genre),
      cast: str(s.cast),
      director: str(s.director),
      rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : undefined,
      tmdbId: str(s.tmdb),
      trailer: str(s.youtube_trailer),
      categoryId: categoryRef(providerId, 'series', s.category_id),
      region: clean.region,
      isAdult: looksAdult(rawName),
      addedAt: epochMs(s.last_modified),
      matchKey: matchKey('series', clean.title, year),
    });
  }
  return out;
}

export interface MovieDetails {
  plot?: string;
  genres?: string[];
  cast?: string;
  director?: string;
  runtimeMin?: number;
  backdrop?: string;
  poster?: string;
  releaseDate?: string;
  trailer?: string;
  /** Technical stream info the panel reports (from ffprobe on the provider side). */
  video?: { codec?: string; width?: number; height?: number };
  audio?: { codec?: string; channels?: number; language?: string };
  container?: string;
}

/** Parse `get_vod_info`. Field names vary between panel versions, so look in several places. */
export function parseVodInfo(json: unknown): MovieDetails {
  const d = (json ?? {}) as Record<string, any>;
  const info = d.info ?? {};
  const movie = d.movie_data ?? {};
  const backdrops = Array.isArray(info.backdrop_path) ? info.backdrop_path : [info.backdrop_path];
  // Prefer the "HH:MM:SS" string: some panels put minutes into `duration_secs`.
  let runtimeMin: number | undefined;
  if (typeof info.duration === 'string' && /^\d{1,2}:\d{2}:\d{2}$/.test(info.duration) && info.duration !== '00:00:00') {
    const [h, m] = info.duration.split(':').map(Number);
    runtimeMin = h * 60 + m;
  } else if (posNum(info.duration_secs) && Number(info.duration_secs) >= 600) runtimeMin = Math.round(Number(info.duration_secs) / 60);
  else if (posNum(info.episode_run_time)) runtimeMin = Number(info.episode_run_time);
  else if (posNum(info.runtime)) runtimeMin = Number(info.runtime);
  const video = info.video ?? {};
  const audio = info.audio ?? {};
  return {
    plot: str(info.plot) ?? str(info.description),
    genres: splitGenres(info.genre),
    cast: str(info.cast) ?? str(info.actors),
    director: str(info.director),
    runtimeMin,
    backdrop: backdrops.map(httpUrl).find(Boolean),
    poster: httpUrl(info.movie_image) ?? httpUrl(info.cover_big),
    releaseDate: str(info.releasedate) ?? str(info.release_date),
    trailer: str(info.youtube_trailer),
    video: video && (video.codec_name || video.width)
      ? { codec: str(video.codec_name), width: posNum(video.width), height: posNum(video.height) }
      : undefined,
    audio: audio && (audio.codec_name || audio.channels)
      ? { codec: str(audio.codec_name), channels: posNum(audio.channels), language: str(audio.tags?.language) }
      : undefined,
    container: str(movie.container_extension)?.toLowerCase(),
  };
}

export interface SeriesDetails {
  seasons: Season[];
  episodes: Episode[];
  plot?: string;
  backdrop?: string;
  genres?: string[];
  cast?: string;
}

/** Parse `get_series_info`. `episodes` is either `{ "1": [...] }` or an array of arrays. */
export function parseSeriesInfo(providerId: string, seriesSourceId: string, json: unknown): SeriesDetails {
  const d = (json ?? {}) as Record<string, any>;
  const seriesId = contentId(providerId, 'series', seriesSourceId);
  const info = d.info ?? {};
  const episodes: Episode[] = [];
  const raw = d.episodes ?? {};
  const groups: Array<[string, any[]]> = Array.isArray(raw)
    ? raw.map((list: any[], i: number) => [String(list?.[0]?.season ?? i + 1), list])
    : Object.entries(raw);
  for (const [seasonKey, list] of groups) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (e?.id === undefined || e?.id === null) continue;
      const einfo = e.info ?? {};
      const season = posNum(e.season) ?? posNum(seasonKey) ?? 1;
      const number = posNum(e.episode_num) ?? episodes.filter((x) => x.season === season).length + 1;
      const rawTitle = str(e.title) ?? `Episode ${number}`;
      episodes.push({
        id: contentId(providerId, 'episode', e.id),
        providerId,
        seriesId,
        sourceId: String(e.id),
        season,
        episode: number,
        title: tidyEpisodeTitle(rawTitle, number),
        plot: str(einfo.plot),
        thumb: httpUrl(einfo.movie_image) ?? httpUrl(einfo.cover_big),
        runtimeSec: posNum(einfo.duration_secs),
        reportedHeight: posNum(einfo.video?.height),
        container: str(e.container_extension)?.toLowerCase(),
        airDate: str(einfo.releasedate) ?? str(einfo.air_date),
      });
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const seasonInfo = new Map<number, any>();
  if (Array.isArray(d.seasons)) for (const s of d.seasons) if (posNum(s?.season_number)) seasonInfo.set(Number(s.season_number), s);
  const seasonNumbers = Array.from(new Set(episodes.map((e) => e.season))).sort((a, b) => a - b);
  const seasons: Season[] = seasonNumbers.map((n) => {
    const s = seasonInfo.get(n);
    return {
      number: n,
      name: n === 0 ? 'Specials' : `Season ${n}`,
      episodeCount: episodes.filter((e) => e.season === n).length,
      poster: httpUrl(s?.cover_tmdb) ?? httpUrl(s?.cover_big) ?? httpUrl(s?.cover),
    };
  });
  const backdrops = Array.isArray(info.backdrop_path) ? info.backdrop_path : [info.backdrop_path];
  return {
    seasons,
    episodes,
    plot: str(info.plot),
    backdrop: backdrops.map(httpUrl).find(Boolean),
    genres: splitGenres(info.genre),
    cast: str(info.cast),
  };
}

/** "Show Name - S01E03 - The Title" → "The Title"; keeps meaningful titles intact. */
function tidyEpisodeTitle(title: string, n: number): string {
  const m = /S\d{1,3}\s*E\d{1,4}\s*[-–:]?\s*(.*)$/i.exec(title);
  const rest = m?.[1]?.trim();
  if (m) return rest && !/^episode\s*\d+$/i.test(rest) ? rest : `Episode ${n}`;
  return title;
}
