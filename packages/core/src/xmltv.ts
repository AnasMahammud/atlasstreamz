import type { EpgChannel, Programme } from './models.ts';

/**
 * Parse an XMLTV timestamp: "20261025160000 +0100", "202610251600", "20261025160000Z".
 * Timestamps without an offset are interpreted with `defaultOffsetMinutes` (UTC by default).
 */
export function parseXmltvTime(raw: string | undefined, defaultOffsetMinutes = 0): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(raw.trim());
  if (!m) return undefined;
  const [, y, mo, d, h = '00', mi = '00', s = '00', tz] = m;
  let offset = defaultOffsetMinutes;
  if (tz === 'Z') offset = 0;
  else if (tz) {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(utc) ? utc - offset * 60_000 : undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  return m ? decodeXmlEntities(m[2] ?? m[3] ?? '') : undefined;
}

/** First child element's text, preferring `lang` matches. */
function childText(xml: string, name: string, preferLangs: string[] = []): string | undefined {
  const re = new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  let first: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const text = decodeXmlEntities(stripCdata(m[2])).trim();
    if (!text) continue;
    if (first === undefined) first = text;
    const lang = m[1] ? attr(m[1], 'lang') : undefined;
    if (lang && preferLangs.some((l) => lang.toLowerCase().startsWith(l))) return text;
  }
  return first;
}

export interface XmltvParserOptions {
  onChannel?: (c: EpgChannel) => void;
  onProgramme: (p: Programme) => void;
  /** Skip programmes for channels not in this set (when the catalogue only maps some). */
  channelFilter?: (epgId: string) => boolean;
  /** Only keep programmes overlapping this window. */
  windowStart?: number;
  windowEnd?: number;
  defaultOffsetMinutes?: number;
  preferLangs?: string[];
}

/**
 * Incremental XMLTV parser. Provider guides are often 50–500 MB, so this works on chunks,
 * finds complete `<channel>` / `<programme>` elements and discards everything else.
 * It is deliberately tolerant: malformed elements are skipped, not fatal.
 */
export class XmltvStreamParser {
  private buf = '';
  channels = 0;
  programmes = 0;
  skipped = 0;

  constructor(private readonly opts: XmltvParserOptions) {}

  push(chunk: string): void {
    this.buf += chunk;
    let pos = 0;
    for (;;) {
      const lt = this.buf.indexOf('<', pos);
      if (lt === -1) {
        pos = this.buf.length;
        break;
      }
      const isProg = this.buf.startsWith('<programme', lt);
      const isChan = !isProg && this.buf.startsWith('<channel', lt);
      if (!isProg && !isChan) {
        // Not an element we care about; skip past this tag.
        const gt = this.buf.indexOf('>', lt);
        if (gt === -1) {
          pos = lt;
          break;
        }
        pos = gt + 1;
        continue;
      }
      const name = isProg ? 'programme' : 'channel';
      const openEnd = this.buf.indexOf('>', lt);
      if (openEnd === -1) {
        pos = lt;
        break;
      }
      if (this.buf[openEnd - 1] === '/') {
        // Self-closing element: no children.
        this.handle(name, this.buf.slice(lt, openEnd + 1), '');
        pos = openEnd + 1;
        continue;
      }
      const close = this.buf.indexOf(`</${name}>`, openEnd);
      if (close === -1) {
        pos = lt;
        break;
      }
      this.handle(name, this.buf.slice(lt, openEnd + 1), this.buf.slice(openEnd + 1, close));
      pos = close + name.length + 3;
    }
    this.buf = this.buf.slice(pos);
    // Guard against a pathological unterminated element eating memory.
    if (this.buf.length > 4_000_000) {
      this.skipped++;
      this.buf = '';
    }
  }

  end(): void {
    this.buf = '';
  }

  private handle(name: string, openTag: string, inner: string): void {
    try {
      if (name === 'channel') {
        const id = attr(openTag, 'id');
        if (!id) return;
        const icon = /<icon[^>]*>/i.exec(inner);
        this.channels++;
        this.opts.onChannel?.({
          id,
          name: childText(inner, 'display-name', this.opts.preferLangs) ?? id,
          icon: icon ? attr(icon[0], 'src') : undefined,
        });
        return;
      }
      const channel = attr(openTag, 'channel');
      if (!channel) return this.skip();
      if (this.opts.channelFilter && !this.opts.channelFilter(channel)) return;
      const start = parseXmltvTime(attr(openTag, 'start'), this.opts.defaultOffsetMinutes);
      const stop = parseXmltvTime(attr(openTag, 'stop'), this.opts.defaultOffsetMinutes);
      if (!start || !stop || stop <= start) return this.skip();
      if (this.opts.windowEnd !== undefined && start >= this.opts.windowEnd) return;
      if (this.opts.windowStart !== undefined && stop <= this.opts.windowStart) return;
      const title = childText(inner, 'title', this.opts.preferLangs);
      if (!title) return this.skip();
      this.programmes++;
      this.opts.onProgramme({
        channelEpgId: channel,
        start,
        stop,
        title,
        desc: childText(inner, 'desc', this.opts.preferLangs),
        category: childText(inner, 'category', this.opts.preferLangs),
        episodeNum: childText(inner, 'episode-num'),
      });
    } catch {
      this.skip();
    }
  }

  private skip(): void {
    this.skipped++;
  }
}

export function parseXmltv(xml: string, opts: Omit<XmltvParserOptions, 'onProgramme' | 'onChannel'> = {}) {
  const channels: EpgChannel[] = [];
  const programmes: Programme[] = [];
  const p = new XmltvStreamParser({ ...opts, onChannel: (c) => channels.push(c), onProgramme: (x) => programmes.push(x) });
  p.push(xml);
  p.end();
  return { channels, programmes, skipped: p.skipped };
}
