/** Typed client for the ATLAS server. Every call is same-origin; the session lives in an httpOnly cookie. */

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
  now?: Programme;
  next?: Programme;
  isNew?: boolean;
  reason?: string;
  seriesId?: string;
}

export interface Programme {
  title: string;
  start: number;
  stop: number;
  desc?: string;
  category?: string;
}

export interface Row {
  id: string;
  title: string;
  layout: 'poster' | 'landscape' | 'channel' | 'continue';
  items: Card[];
  href?: string;
  note?: string;
}

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

export interface ProfilePrefs {
  subtitleLang?: string;
  audioLang?: string;
  autoplayNext?: boolean;
  regions?: string[];
  maturity?: 'kids' | 'teen' | 'all';
  reducedMotion?: boolean;
  subtitleStyle?: { size: number; background: number };
  dataSaver?: boolean;
  lockSettings?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  avatar: string;
  hasPin: boolean;
  isKids: boolean;
  prefs: ProfilePrefs;
}

export interface Provider {
  id: string;
  name: string;
  type: 'xtream' | 'm3u';
  host: string;
  secure: boolean;
  needsHttpConsent: boolean;
  enabled: boolean;
  autoSync: boolean;
  account?: {
    auth: boolean;
    status?: string;
    expiresAt?: number;
    isTrial?: boolean;
    maxConnections?: number;
    activeConnections?: number;
    outputFormats: string[];
  };
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  consecutiveFailures: number;
  lastError?: string;
}

export interface SyncSummary {
  channels: number;
  movies: number;
  series: number;
  epgProgrammes: number;
  epgError?: string;
  added: { channels: number; movies: number; series: number };
  removed: { channels: number; movies: number; series: number };
  renamedChannels: number;
  durationMs: number;
}

export interface SyncInfo {
  running: null | { providerId: string; stage: string; detail?: string; startedAt: number };
  queue: string[];
  last: Record<string, { ok: boolean; finishedAt: number; summary?: SyncSummary; error?: string }>;
  next: Record<string, number | null>;
}

export interface Status {
  setupRequired: boolean;
  /** Public deployments: creating the owner account needs the host's ATLAS_SETUP_TOKEN. */
  setupCodeRequired?: boolean;
  /** Who may create an account on this server. */
  registration?: 'closed' | 'invite' | 'open';
  signedIn: boolean;
  account?: { email: string; role: 'owner' | 'member' } | null;
  profile: Profile | null;
  providers?: Provider[];
  sync?: SyncInfo;
  catalog?: { channels: number; movies: number; series: number; programmes: number };
  server: { version: string; time: number };
}

export interface Category {
  id: string;
  name: string;
  genre?: string;
  region?: string;
  count: number;
  /** Live categories: channels with guide listings. */
  guideCount?: number;
}

export interface MovieDetail extends Card {
  plot?: string;
  genres?: string[];
  cast?: string;
  director?: string;
  runtimeMin?: number;
  container?: string;
  qualityHint?: string;
  releaseDate?: string;
  trailer?: string;
  reported?: { video?: { codec?: string; width?: number; height?: number }; audio?: { codec?: string; channels?: number; language?: string } };
  verified?: { width: number; height: number };
  related: Card[];
  inList: boolean;
  progress?: { position: number; duration: number; finished: boolean };
}

export interface Episode {
  id: string;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  thumb?: string;
  runtimeSec?: number;
  airDate?: string;
  reportedHeight?: number;
}

export interface SeriesDetail extends Card {
  plot?: string;
  genres?: string[];
  cast?: string;
  director?: string;
  seasons: Array<{ number: number; name: string; episodeCount: number; poster?: string }>;
  episodes: Episode[];
  related: Card[];
  inList: boolean;
  episodeProgress: Record<string, { position: number; duration: number; finished: boolean }>;
  nextEpisodeId?: string;
}

export interface ChannelDetail extends Card {
  epgId?: string;
  schedule: Programme[];
  alternates: Array<{ id: string; title: string; category?: string }>;
  inList: boolean;
  prevChannel?: string;
  nextChannel?: string;
}

export interface PlaybackSource {
  engine: 'hls' | 'mpegts' | 'native';
  url: string;
  label: string;
  mime?: string;
}

export interface PlayInfo {
  id: string;
  kind: 'live' | 'movie' | 'episode';
  title: string;
  subtitle?: string;
  artwork?: string;
  seriesId?: string;
  sources: PlaybackSource[];
  resumeAt: number;
  episode?: { season: number; episode: number; title: string };
  nextEpisode?: Card;
  live?: {
    now?: Programme;
    next?: Programme;
    number?: number;
    logo?: string;
    alternates: Array<{ id: string; title: string; category?: string }>;
    prevChannel?: string;
    nextChannel?: string;
  } | null;
  verified?: { width: number; height: number };
  autoplayNext: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: Record<string, any> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, navigator.onLine ? 'Can’t reach the ATLAS server.' : 'You’re offline.', { offline: !navigator.onLine });
  }
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data);
  return data as T;
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, signal),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
};

export const enc = encodeURIComponent;

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
