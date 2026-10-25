/**
 * Device class detection. TVs get a remote-first layout without live blur; phones get the
 * bottom bar. `?device=tv` forces TV mode for testing on a desktop browser.
 */
export type DeviceClass = 'tv' | 'desktop' | 'mobile';

export function detectDevice(): DeviceClass {
  const forced = new URLSearchParams(location.search).get('device') ?? sessionStorageGet('atlas.device');
  if (forced === 'tv' || forced === 'desktop' || forced === 'mobile') {
    sessionStorageSet('atlas.device', forced);
    return forced;
  }
  const ua = navigator.userAgent;
  // The ATLAS Android app tells us whether it runs on a TV (Android TV / Fire TV) or a phone.
  if (/AtlasApp\/[^ ]+ \(TV\)/.test(ua)) return 'tv';
  if (/Android TV|AFT[A-Z]|SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|GoogleTV|CrKey|Fire TV|HbbTV/i.test(ua)) return 'tv';
  if (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820) return 'mobile';
  return 'desktop';
}

function sessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function sessionStorageSet(key: string, v: string): void {
  try {
    sessionStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode */
  }
}

export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Track the last input modality so focus rings only show for keyboards and remotes. */
export function trackInputMode(): void {
  const root = document.documentElement;
  const set = (mode: string) => {
    if (root.dataset.input !== mode) root.dataset.input = mode;
  };
  window.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow') || e.key === 'Tab' || e.key === 'Enter') set('keys');
  }, { capture: true, passive: true });
  window.addEventListener('pointerdown', (e) => set(e.pointerType === 'touch' ? 'touch' : 'pointer'), { capture: true, passive: true });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') set('pointer');
  }, { capture: true, passive: true });
}
