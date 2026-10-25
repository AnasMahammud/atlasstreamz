export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${Math.max(1, m)}m`;
}

export function formatClock(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '0:00';
  const s = Math.floor(totalSec % 60);
  const m = Math.floor((totalSec / 60) % 60);
  const h = Math.floor(totalSec / 3600);
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
}

/** Remaining-time label for Continue Watching cards ("1h 15m left"). */
export function remainingLabel(positionSec: number, durationSec: number): string {
  if (!durationSec || durationSec <= 0) return '';
  return `${formatDuration(Math.max(0, durationSec - positionSec))} left`;
}

/**
 * Map a measured frame size to an honest quality label. Widescreen films are letterboxed
 * (1920×800 is a 1080p encode), so the width counts as much as the height.
 */
export function qualityFromHeight(height: number | undefined, width?: number): string | undefined {
  if (!height) return undefined;
  const effective = Math.max(height, width ? Math.round((width * 9) / 16) : 0);
  if (effective >= 2000) return '4K';
  if (effective >= 1400) return '1440p';
  if (effective >= 1000) return '1080p';
  if (effective >= 700) return '720p';
  return 'SD';
}

/**
 * TMDB image URLs carry a size segment. Ask for a size that fits the card instead of the
 * provider's default, which keeps memory low on TVs.
 */
export function tmdbSized(url: string | undefined, size: 'w92' | 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original'): string | undefined {
  if (!url) return url;
  return url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1${size}/`);
}
