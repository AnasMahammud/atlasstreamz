/**
 * Title, category and quality normalisation for provider-supplied names.
 *
 * Provider catalogues encode a lot of metadata inside display names
 * ("DE | Drama", "Superman (2025) 4K", "UK: BBC One FHD"). We pull those apart so
 * the UI can show clean titles, while keeping every claim attributed to the provider.
 */

const QUALITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(4k|uhd|2160p)\b/i, '4K'],
  [/\b(fhd|1080p|1080i)\b/i, 'FHD'],
  [/\b(hd|720p)\b/i, 'HD'],
  [/\b(sd|480p|576p)\b/i, 'SD'],
];

const CODEC_TAGS = /\b(hevc|h\.?265|x265|h\.?264|x264|hdr10\+?|hdr|dolby\s?vision|dv|multi[- ]?sub|multi[- ]?audio|raw|vip|backup|\+1)\b/gi;

/** Region prefixes like "UK: ", "DE | ", "U.S.A - ", "[FR] ", "|AR| ". */
const REGION_PREFIX = /^\s*(?:\[([^\]]{1,14})\]|\|([^|]{1,14})\||([A-Za-z.]{2,12}(?:\s[A-Za-z.]{1,8})?)\s*(?:\||:|-)\s+)/;

const KNOWN_REGIONS = new Set([
  'uk', 'u.k', 'us', 'usa', 'u.s.a', 'ca', 'canada', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'br', 'ar', 'tr', 'pl', 'se',
  'no', 'dk', 'fi', 'ie', 'ireland', 'scotland', 'in', 'pk', 'au', 'nz', 'mx', 'latino', 'arabic', 'gr', 'ro', 'al',
  'ex-yu', 'exyu', 'ru', 'ua', 'be', 'ch', 'at', 'af', 'kr', 'jp', 'cn', 'ph', 'za', 'nordic', 'balkan', 'latam',
]);

export interface CleanTitle {
  title: string;
  year?: number;
  qualityHint?: string;
  region?: string;
}

export function detectQuality(name: string): string | undefined {
  for (const [re, label] of QUALITY_PATTERNS) if (re.test(name)) return label;
  return undefined;
}

export function splitRegion(name: string): { region?: string; rest: string } {
  const m = REGION_PREFIX.exec(name);
  if (!m) return { rest: name };
  const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!KNOWN_REGIONS.has(key) && !KNOWN_REGIONS.has(key.replace(/\./g, ''))) return { rest: name };
  // Short codes are only regions when written in capitals: "IT - Drama" yes, "It - 2017" no.
  const compact = raw.replace(/\./g, '');
  if (compact.length <= 3 && compact !== compact.toUpperCase()) return { rest: name };
  const rest = name.slice(m[0].length);
  if (!rest.trim() || /^\s*[(\[]?(19|20)\d{2}[)\]]?\s*$/.test(rest)) return { rest: name };
  return { region: compact.toUpperCase(), rest };
}

/** Clean a movie/series display name. */
export function cleanTitle(raw: string): CleanTitle {
  let name = (raw ?? '').replace(/\s+/g, ' ').trim();
  const { region, rest } = splitRegion(name);
  name = rest;
  const qualityHint = detectQuality(name);

  let year: number | undefined;
  // "Title (2025)", "Title - 2025", "Title [2025]", "Title 2025" at the end.
  const yearMatch = /(?:\s*[-–(\[]\s*|\s+)((?:19|20)\d{2})\s*[)\]]?\s*$/.exec(stripTags(name));
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    if (y >= 1900 && y <= 2100) {
      year = y;
    }
  }
  let title = stripTags(name);
  if (yearMatch && year) title = title.slice(0, yearMatch.index).trim();
  title = title.replace(/[\s\-–:|]+$/g, '').trim();
  if (!title) title = (raw ?? '').trim();
  return { title, year, qualityHint, region };
}

function stripTags(s: string): string {
  return s
    .replace(CODEC_TAGS, ' ')
    .replace(/\b(4k|uhd|2160p|fhd|1080p|1080i|720p|480p|576p)\b/gi, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clean a live channel name ("Sportsnet+ 17 :" → "Sportsnet+ 17"). */
export function cleanChannelName(raw: string): CleanTitle {
  const base = (raw ?? '').replace(/\s+/g, ' ').trim();
  const { region, rest } = splitRegion(base);
  const qualityHint = detectQuality(rest);
  let title = rest
    .replace(/\b(fhd|uhd|4k|hevc|h265|raw|vip|backup|\d{2,3}\s?fps)\b/gi, ' ')
    .replace(/\bhd\b(?=\s*$)/i, ' ')
    .replace(/\bhd\b(?=\s*$)/i, ' ')
    .replace(/[\s:|\-–]+$/g, '')
    .replace(/^[\s:|\-–]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) title = base;
  return { title, qualityHint, region };
}

/** Lower-case, diacritic-free, punctuation-free key for matching. */
export function normalizeKey(s: string): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Key used to re-match a title across syncs when the provider changes its stream IDs. */
export function matchKey(kind: string, title: string, year?: number): string {
  return `${kind}|${normalizeKey(title)}|${year ?? ''}`;
}

// Order matters: the first matching rule wins ("Kids Animation" → kids, "Sci-Fi Horror" → scifi).
// Patterns are word-prefix matches so "Comedy", "Documentary", "Animation" all hit.
const GENRE_RULES: Array<[RegExp, string]> = [
  [/\b(sports?|football|soccer|premier league|nba|nfl|nhl|mlb|ufc|boxing|ppv|f1|formula ?1|motogp|tennis|golf|cricket|rugby|dazn|espn|tsn|sportsnet|bein|uefa|efl|wwe|racing|horses|greyhounds|gaelic|league|world cup|epl|replays?)\b/i, 'sports'],
  [/\b(news|nachrichten|noticias|cnn|bbc news|sky news|cnbc|bloomberg|talk)\b/i, 'news'],
  [/\b(kids?|family|famil\w*|children|cartoons?|disney junior|nick\w*)\b/i, 'kids'],
  [/\b(docs?|document\w*|dokument\w*|discovery|nat ?geo|history|reality)\b/i, 'documentary'],
  [/\b(music|concerts?|musical\w*|musik|mtv|stand-?ups?)\b/i, 'music'],
  [/\b(sci[- ]?fi|science fiction|fantasy)\b/i, 'scifi'],
  [/\b(animat\w*|anime)\b/i, 'animation'],
  [/\b(action|adventure|abenteuer|war|kriegsfilm)\b/i, 'action'],
  [/\b(comed\w*|kom(ö|o|.)die)\b/i, 'comedy'],
  [/\b(horror|thriller|halloween)\b/i, 'horror'],
  [/\b(crime|krimi|mystery)\b/i, 'crime'],
  [/\b(drama)\b/i, 'drama'],
  [/\b(romance|liebesfilm|romantic)\b/i, 'romance'],
  [/\b(western)\b/i, 'western'],
  [/\b(movies?|cinema|film)\b/i, 'movies'],
  [/\b(entertainment|general)\b/i, 'entertainment'],
];

export function genreFromName(name: string): string | undefined {
  for (const [re, g] of GENRE_RULES) if (re.test(name)) return g;
  return undefined;
}

export const GENRE_LABELS: Record<string, string> = {
  sports: 'Sports',
  news: 'News',
  kids: 'Kids & Family',
  documentary: 'Documentaries',
  music: 'Music',
  scifi: 'Science Fiction',
  action: 'Action & Adventure',
  comedy: 'Comedy',
  horror: 'Horror & Thriller',
  crime: 'Crime & Mystery',
  drama: 'Drama',
  romance: 'Romance',
  animation: 'Animation',
  western: 'Western',
  movies: 'Movies',
  entertainment: 'Entertainment',
};

const ADULT = /\b(adult|xxx|18\+|porn|erotic)\b/i;
export function looksAdult(name: string): boolean {
  return ADULT.test(name);
}

/** Split provider genre strings like "Drama / Mystery" or "Action, Adventure". */
export function splitGenres(raw?: string | null): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/\s*(?:\/|,|\||&)\s*/)
    .map((g) => g.trim())
    .filter(Boolean);
  return parts.length ? Array.from(new Set(parts)) : undefined;
}
