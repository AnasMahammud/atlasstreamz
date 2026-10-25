import type { M3UEntry, M3UHeader } from './models.ts';

/**
 * Incremental Extended-M3U parser.
 *
 * Feed it text chunks with `push()` and it emits entries as soon as their URL line
 * arrives, so a 50 MB provider playlist never has to be held as one string.
 *
 * Handles: `#EXTM3U` header attributes, `#EXTINF` with quoted/unquoted attributes and
 * commas inside quotes, `#EXTGRP`, `#EXTVLCOPT`, `#KODIPROP`, CRLF/LF/CR line endings,
 * a UTF-8 BOM, blank lines, and stray comment lines between `#EXTINF` and its URL.
 */
export class M3UStreamParser {
  private buffer = '';
  private pending: Omit<M3UEntry, 'url'> | null = null;
  private pendingOptions: Record<string, string> = {};
  private pendingGroup: string | undefined;
  private sawFirstLine = false;
  header: M3UHeader = { attrs: {}, epgUrls: [] };
  count = 0;
  skipped = 0;

  constructor(private readonly onEntry: (entry: M3UEntry) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf('\n', start);
      if (nl === -1) break;
      this.line(this.buffer.slice(start, nl));
      start = nl + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  end(): void {
    if (this.buffer) this.line(this.buffer);
    this.buffer = '';
    if (this.pending) this.skipped++;
    this.pending = null;
  }

  private line(rawLine: string): void {
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!this.sawFirstLine) {
      this.sawFirstLine = true;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    }
    // Old Mac line endings: split any embedded CRs.
    if (line.includes('\r')) {
      for (const part of line.split('\r')) this.line(part);
      return;
    }
    line = line.trim();
    if (!line) return;

    if (line.startsWith('#')) {
      const upper = line.slice(0, 12).toUpperCase();
      if (upper.startsWith('#EXTM3U')) {
        const attrs = parseAttributes(line.slice(7));
        this.header.attrs = { ...this.header.attrs, ...attrs };
        for (const key of ['url-tvg', 'x-tvg-url', 'tvg-url']) {
          const v = attrs[key];
          if (v) for (const u of v.split(',')) if (u.trim()) this.header.epgUrls.push(u.trim());
        }
      } else if (upper.startsWith('#EXTINF:')) {
        if (this.pending) this.skipped++;
        this.pending = parseExtinf(line);
        this.pending.options = { ...this.pendingOptions };
        if (this.pendingGroup && !this.pending.group) this.pending.group = this.pendingGroup;
      } else if (upper.startsWith('#EXTGRP:')) {
        const g = line.slice(8).trim();
        if (this.pending) this.pending.group ??= g;
        else this.pendingGroup = g;
      } else if (upper.startsWith('#EXTVLCOPT:') || upper.startsWith('#KODIPROP:')) {
        const body = line.slice(line.indexOf(':') + 1);
        const eq = body.indexOf('=');
        if (eq > 0) {
          const key = body.slice(0, eq).trim().toLowerCase();
          const value = body.slice(eq + 1).trim();
          if (this.pending) this.pending.options[key] = value;
          else this.pendingOptions[key] = value;
        }
      }
      return;
    }

    // A URL line.
    if (!this.pending) {
      // Bare URL with no #EXTINF: still playable, title from the URL.
      this.emit({ title: titleFromUrl(line), url: line, duration: -1, attrs: {}, options: { ...this.pendingOptions }, group: this.pendingGroup });
    } else {
      this.emit({ ...this.pending, url: line });
    }
    this.pending = null;
    this.pendingOptions = {};
    this.pendingGroup = undefined;
  }

  private emit(entry: M3UEntry): void {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(entry.url)) {
      this.skipped++;
      return;
    }
    if (!entry.group && entry.attrs['group-title']) entry.group = entry.attrs['group-title'];
    this.count++;
    this.onEntry(entry);
  }
}

/** Parse a whole playlist string. Convenience wrapper for small inputs and tests. */
export function parseM3U(text: string): { header: M3UHeader; entries: M3UEntry[]; skipped: number } {
  const entries: M3UEntry[] = [];
  const parser = new M3UStreamParser((e) => entries.push(e));
  parser.push(text);
  parser.end();
  return { header: parser.header, entries, skipped: parser.skipped };
}

function parseExtinf(line: string): Omit<M3UEntry, 'url'> {
  const body = line.slice(8);
  // Duration runs until the first space or comma.
  let i = 0;
  while (i < body.length && body[i] !== ' ' && body[i] !== ',') i++;
  const duration = Number.parseFloat(body.slice(0, i));
  // The title is everything after the first comma that is not inside quotes.
  let inQuote = false;
  let commaAt = -1;
  for (let j = i; j < body.length; j++) {
    const c = body[j];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      commaAt = j;
      break;
    }
  }
  const attrPart = commaAt === -1 ? body.slice(i) : body.slice(i, commaAt);
  const title = commaAt === -1 ? '' : body.slice(commaAt + 1).trim();
  const attrs = parseAttributes(attrPart);
  return {
    title: title || attrs['tvg-name'] || '',
    duration: Number.isFinite(duration) ? duration : -1,
    attrs,
    options: {},
    group: attrs['group-title'] || undefined,
  };
}

/** Parse `key="value" key2=value2` pairs. Keys are lower-cased (providers mix `tvg-ID`/`tvg-id`). */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"',]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
    return decodeURIComponent(last).replace(/\.[a-z0-9]{2,4}$/i, '');
  } catch {
    return url;
  }
}

export type M3UStreamKind = 'live' | 'movie' | 'episode';

/**
 * Classify a playlist URL. Xtream-style panels put VOD under `/movie/` and episodes under
 * `/series/`; everything else is treated as a live channel. File extensions are a
 * secondary signal for plain M3U files of VOD content.
 */
export function classifyStreamUrl(url: string, durationSec = -1): M3UStreamKind {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep raw */
  }
  const p = path.toLowerCase();
  if (p.includes('/movie/')) return 'movie';
  if (p.includes('/series/')) return 'episode';
  if (/\.(mp4|mkv|avi|mov|m4v|wmv)$/.test(p) && durationSec !== -1) return 'movie';
  if (/\.(mkv|avi|mov|m4v|wmv)$/.test(p)) return 'movie';
  return 'live';
}

/** The trailing numeric/opaque stream identifier in an Xtream-style URL. */
export function streamIdFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!last) return undefined;
    return last.replace(/\.[a-z0-9]{2,4}$/i, '');
  } catch {
    return undefined;
  }
}

/**
 * Parse an episode marker out of a playlist title: "Show S01 E05", "Show S1E5", "Show 1x05",
 * and the panel style "Show (2025) S01 Show (2025) - S01E01 - Episode Title".
 */
export function parseEpisodeMarker(title: string): { show: string; season: number; episode: number; episodeTitle?: string } | null {
  const m = /^(.*?)[\s._-]*\bS(\d{1,3})\s*[._-]?\s*E(\d{1,4})\b(.*)$/i.exec(title) ?? /^(.*?)[\s._-]+(\d{1,2})x(\d{1,3})\b(.*)$/i.exec(title);
  if (!m) return null;
  // Drop a repeated "S01 Show (2025)" season prefix that some panels insert.
  const show = m[1].replace(/\s+S\d{1,3}\b.*$/i, '').replace(/[\s._-]+$/, '').trim();
  const episodeTitle = m[4].replace(/^[\s._:–-]+/, '').trim() || undefined;
  return { show, season: Number(m[2]), episode: Number(m[3]), episodeTitle };
}
