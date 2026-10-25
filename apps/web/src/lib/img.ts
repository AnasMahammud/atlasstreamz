/**
 * Artwork URLs. TMDB images are requested at the size the card needs (less memory on TVs);
 * plain-HTTP artwork goes through the server's caching proxy to avoid mixed content.
 */
type Size = 'w92' | 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original';

export function art(url: string | undefined | null, size: Size = 'w342'): string | undefined {
  if (!url) return undefined;
  if (url.includes('image.tmdb.org/t/p/')) return url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1${size}/`).replace(/^http:/, 'https:');
  if (url.startsWith('http://')) return `/api/img?u=${encodeURIComponent(url)}`;
  return url;
}

/** Device-aware backdrop size: TVs and phones don't need 1280px blurred backgrounds. */
export function backdropSize(): Size {
  const w = window.innerWidth * Math.min(2, window.devicePixelRatio || 1);
  if (document.documentElement.dataset.device === 'tv') return 'w1280';
  return w > 1600 ? 'original' : w > 900 ? 'w1280' : 'w780';
}
