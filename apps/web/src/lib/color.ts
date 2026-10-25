import { art } from './img.ts';

/**
 * Ambient accent extraction. We draw a tiny (w92) copy of the artwork onto a 12×12 canvas
 * and pick the most saturated mid-luminance colour. Results are cached per URL, so focus
 * changes cost nothing after the first visit.
 */
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export function accentFor(url: string | undefined): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(url);
  if (p) return p;
  p = new Promise<string | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 12;
        c.height = 12;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 12, 12);
        const d = ctx.getImageData(0, 0, 12, 12).data;
        let best = { score: -1, r: 129, g: 199, b: 255 };
        let sum = { r: 0, g: 0, b: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          sum.r += r;
          sum.g += g;
          sum.b += b;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const l = (max + min) / 510;
          const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
          const score = s * (1 - Math.abs(l - 0.5) * 1.6);
          if (score > best.score) best = { score, r, g, b };
        }
        const n = d.length / 4;
        // Low-saturation art (grey/black posters) falls back to its average, lifted.
        const pick = best.score > 0.18 ? best : { r: sum.r / n, g: sum.g / n, b: sum.b / n };
        const lift = (v: number) => Math.round(Math.min(255, v * 0.75 + 60));
        const value = `${lift(pick.r)} ${lift(pick.g)} ${lift(pick.b)}`;
        cache.set(url, value);
        resolve(value);
      } catch {
        resolve(null); // Tainted canvas (no CORS) — keep the current accent.
      } finally {
        pending.delete(url);
      }
    };
    img.onerror = () => {
      pending.delete(url);
      resolve(null);
    };
    img.src = art(url, 'w92') ?? url;
  });
  pending.set(url, p);
  return p;
}
