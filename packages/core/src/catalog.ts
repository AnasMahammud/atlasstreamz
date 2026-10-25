import type { Category, CatalogKind, Episode, LiveChannel, M3UEntry, Movie, Series } from './models.ts';
import { contentId } from './ids.ts';
import { classifyStreamUrl, parseEpisodeMarker, streamIdFromUrl } from './m3u.ts';
import { cleanChannelName, cleanTitle, genreFromName, looksAdult, matchKey, normalizeKey, splitRegion } from './normalize.ts';
import { fnv1a } from './hash.ts';

/** A playable entry plus the URL it came from. URLs stay server-side. */
export interface WithUrl<T> {
  item: T;
  url: string;
  /** Per-stream request options from the playlist (user-agent, referrer). */
  options?: Record<string, string>;
}

export interface M3UCatalog {
  categories: Category[];
  channels: WithUrl<LiveChannel>[];
  movies: WithUrl<Movie>[];
  series: Series[];
  episodes: WithUrl<Episode>[];
  /** Channels that duplicate another channel's name in the same group: kept as fallbacks. */
  alternates: Map<string, string[]>;
  duplicatesDropped: number;
}

/**
 * Turn raw M3U entries into the ATLAS catalogue.
 *
 * - Xtream-style URLs (`/movie/`, `/series/`) classify VOD and episodes; the rest is live.
 * - IDs prefer the provider's stream id from the URL, then `tvg-id`, then a hash of
 *   name+group — so they stay stable when the playlist is reordered.
 * - Exact duplicate URLs are dropped. Same-name channels in one group are linked as
 *   alternates for the stream-recovery engine instead of cluttering the UI.
 */
export class M3UCatalogBuilder {
  private categories = new Map<string, Category>();
  private channels: WithUrl<LiveChannel>[] = [];
  private movies: WithUrl<Movie>[] = [];
  private series = new Map<string, Series>();
  private episodes: WithUrl<Episode>[] = [];
  private seenUrls = new Set<string>();
  private seenIds = new Set<string>();
  private channelByName = new Map<string, string>();
  private alternates = new Map<string, string[]>();
  private duplicatesDropped = 0;
  private catSort = 0;
  private liveNumber = 0;
  private episodeCounter = new Map<string, number>();

  constructor(private readonly providerId: string) {}

  add(e: M3UEntry): void {
    if (this.seenUrls.has(e.url)) {
      this.duplicatesDropped++;
      return;
    }
    this.seenUrls.add(e.url);
    const kind = classifyStreamUrl(e.url, e.duration);
    const group = (e.group ?? '').trim() || (kind === 'live' ? 'Uncategorised' : kind === 'movie' ? 'Movies' : 'Series');
    const rawTitle = (e.title || e.attrs['tvg-name'] || '').trim();
    const urlId = streamIdFromUrl(e.url);
    const options = Object.keys(e.options).length ? e.options : undefined;

    if (kind === 'live') {
      const catId = this.category('live', group);
      const clean = cleanChannelName(rawTitle);
      const sourceId = this.uniqueSource('live', urlId && /^\d+$/.test(urlId) ? urlId : e.attrs['tvg-id'] || fnv1a(`${rawTitle}|${group}|${e.url}`));
      const id = contentId(this.providerId, 'live', sourceId);
      const chno = Number(e.attrs['tvg-chno']);
      const nameKey = `${catId}|${normalizeKey(clean.title)}`;
      const primary = this.channelByName.get(nameKey);
      if (primary) {
        // Same name in the same group: a backup feed. Keep it reachable for recovery.
        const list = this.alternates.get(primary) ?? [];
        list.push(id);
        this.alternates.set(primary, list);
      } else {
        this.channelByName.set(nameKey, id);
      }
      this.channels.push({
        url: e.url,
        options,
        item: {
          id,
          providerId: this.providerId,
          sourceId,
          name: clean.title,
          logo: httpUrl(e.attrs['tvg-logo']),
          categoryId: catId,
          number: Number.isFinite(chno) && chno > 0 ? chno : ++this.liveNumber,
          epgId: e.attrs['tvg-id'] || undefined,
          catchupDays: Number(e.attrs['catchup-days']) > 0 ? Number(e.attrs['catchup-days']) : undefined,
          qualityHint: clean.qualityHint,
          region: clean.region,
          isAdult: looksAdult(rawTitle) || looksAdult(group),
          matchKey: matchKey('live', clean.title),
        },
      });
      return;
    }

    if (kind === 'movie') {
      const catId = this.category('movie', group);
      const clean = cleanTitle(rawTitle);
      const sourceId = this.uniqueSource('movie', urlId ?? fnv1a(e.url));
      const ext = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(e.url)?.[1]?.toLowerCase();
      this.movies.push({
        url: e.url,
        options,
        item: {
          id: contentId(this.providerId, 'movie', sourceId),
          providerId: this.providerId,
          sourceId,
          title: clean.title,
          year: clean.year,
          poster: httpUrl(e.attrs['tvg-logo']),
          categoryId: catId,
          container: ext,
          qualityHint: clean.qualityHint,
          region: clean.region,
          isAdult: looksAdult(rawTitle) || looksAdult(group),
          matchKey: matchKey('movie', clean.title, clean.year),
        },
      });
      return;
    }

    // Episode: group into a series by the show name parsed from the title.
    const marker = parseEpisodeMarker(rawTitle);
    const showRaw = marker?.show || rawTitle;
    const show = cleanTitle(showRaw);
    const seriesSource = fnv1a(`${normalizeKey(show.title)}|${show.year ?? ''}`);
    const seriesId = contentId(this.providerId, 'series', seriesSource);
    if (!this.series.has(seriesId)) {
      const catId = this.category('series', group);
      this.series.set(seriesId, {
        id: seriesId,
        providerId: this.providerId,
        sourceId: seriesSource,
        title: show.title,
        year: show.year,
        poster: httpUrl(e.attrs['tvg-logo']),
        categoryId: catId,
        region: show.region,
        isAdult: looksAdult(rawTitle) || looksAdult(group),
        matchKey: matchKey('series', show.title, show.year),
      });
    }
    const sourceId = this.uniqueSource('episode', urlId ?? fnv1a(e.url));
    const ordinal = (this.episodeCounter.get(seriesId) ?? 0) + 1;
    this.episodeCounter.set(seriesId, ordinal);
    const ext = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(e.url)?.[1]?.toLowerCase();
    this.episodes.push({
      url: e.url,
      options,
      item: {
        id: contentId(this.providerId, 'episode', sourceId),
        providerId: this.providerId,
        seriesId,
        sourceId,
        season: marker?.season ?? 1,
        episode: marker?.episode ?? ordinal,
        title: marker ? marker.episodeTitle ?? `Episode ${marker.episode}` : rawTitle,
        thumb: httpUrl(e.attrs['tvg-logo']),
        container: ext,
      },
    });
  }

  build(): M3UCatalog {
    return {
      categories: Array.from(this.categories.values()),
      channels: this.channels,
      movies: this.movies,
      series: Array.from(this.series.values()),
      episodes: this.episodes,
      alternates: this.alternates,
      duplicatesDropped: this.duplicatesDropped,
    };
  }

  private category(kind: CatalogKind, name: string): string {
    const sourceId = fnv1a(`${kind}|${name}`);
    const id = contentId(this.providerId, 'category', `${kind}-${sourceId}`);
    if (!this.categories.has(id)) {
      this.categories.set(id, {
        id,
        providerId: this.providerId,
        kind,
        sourceId,
        name,
        genre: genreFromName(name),
        region: splitRegion(name).region,
        isAdult: looksAdult(name),
        sort: this.catSort++,
      });
    }
    return id;
  }

  private uniqueSource(kind: string, base: string): string {
    let candidate = base;
    let n = 1;
    while (this.seenIds.has(`${kind}:${candidate}`)) candidate = `${base}~${++n}`;
    this.seenIds.add(`${kind}:${candidate}`);
    return candidate;
  }
}

function httpUrl(v: string | undefined): string | undefined {
  return v && /^https?:\/\//i.test(v) ? v : undefined;
}
