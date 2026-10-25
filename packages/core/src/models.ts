/**
 * Canonical ATLAS content models. Every platform (web, server, native) speaks these shapes.
 *
 * IDs are stable strings of the form `<providerId>:<kind>:<sourceId>` so favourites and
 * progress survive playlist reordering. See ids.ts.
 */

export type ContentKind = 'live' | 'movie' | 'series' | 'episode';
export type CatalogKind = 'live' | 'movie' | 'series';

export type ProviderType = 'xtream' | 'm3u';

/** Where a piece of metadata came from, so the UI can attribute it honestly. */
export type MetadataSource = 'provider' | 'user' | 'derived';

export interface Category {
  id: string;
  providerId: string;
  kind: CatalogKind;
  sourceId: string;
  name: string;
  /** Normalised genre key derived from the name (e.g. "action", "news"). */
  genre?: string;
  /** Country/language prefix parsed from names like "U.K - News" or "DE | Drama". */
  region?: string;
  isAdult?: boolean;
  sort: number;
}

export interface LiveChannel {
  id: string;
  providerId: string;
  sourceId: string;
  name: string;
  logo?: string;
  categoryId?: string;
  number?: number;
  epgId?: string;
  catchupDays?: number;
  /** Quality claimed by the provider's naming (e.g. "FHD"). Not verified. */
  qualityHint?: string;
  region?: string;
  isAdult: boolean;
  /** Key used to re-match favourites when a provider renumbers its streams. */
  matchKey: string;
  addedAt?: number;
}

export interface Movie {
  id: string;
  providerId: string;
  sourceId: string;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  plot?: string;
  genres?: string[];
  cast?: string;
  director?: string;
  runtimeMin?: number;
  /** Provider-supplied rating on a 0–10 scale. Shown with attribution only. */
  rating?: number;
  tmdbId?: string;
  trailer?: string;
  categoryId?: string;
  container?: string;
  qualityHint?: string;
  region?: string;
  isAdult: boolean;
  addedAt?: number;
  matchKey: string;
}

export interface Series {
  id: string;
  providerId: string;
  sourceId: string;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  plot?: string;
  genres?: string[];
  cast?: string;
  director?: string;
  rating?: number;
  tmdbId?: string;
  trailer?: string;
  categoryId?: string;
  region?: string;
  isAdult: boolean;
  addedAt?: number;
  matchKey: string;
}

export interface Episode {
  id: string;
  providerId: string;
  seriesId: string;
  sourceId: string;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  thumb?: string;
  runtimeSec?: number;
  container?: string;
  airDate?: string;
  /** Vertical resolution the panel reports for the file. Provider claim, not verified playback. */
  reportedHeight?: number;
}

export interface Season {
  number: number;
  name: string;
  episodeCount: number;
  poster?: string;
}

export interface Programme {
  channelEpgId: string;
  start: number;
  stop: number;
  title: string;
  desc?: string;
  category?: string;
  episodeNum?: string;
}

export interface EpgChannel {
  id: string;
  name: string;
  icon?: string;
}

/** A raw entry parsed out of an M3U/M3U8 playlist. */
export interface M3UEntry {
  title: string;
  url: string;
  duration: number;
  attrs: Record<string, string>;
  /** `#EXTVLCOPT` / `#KODIPROP` options (user-agent, referrer, …). */
  options: Record<string, string>;
  group?: string;
}

export interface M3UHeader {
  attrs: Record<string, string>;
  /** EPG URLs announced by the playlist header (url-tvg / x-tvg-url). */
  epgUrls: string[];
}

export interface PlaybackProgress {
  contentId: string;
  kind: ContentKind;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
  finished: boolean;
}

export interface HistoryEntry {
  contentId: string;
  kind: ContentKind;
  /** Category / genre signals for the recommender. */
  categoryId?: string;
  genres?: string[];
  watchedAt: number;
  /** 0..1 share of the title that was watched. */
  completion: number;
}
