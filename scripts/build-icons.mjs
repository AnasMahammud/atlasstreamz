// Renders the ATLAS brand assets (PWA icons, Android adaptive/launcher icons, Android TV
// banner, Fire TV icon, favicon PNGs) from SVG sources with sharp.
//   node scripts/build-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webIcons = join(root, 'apps/web/public/icons');
const brand = join(root, 'assets/brand');
mkdirSync(webIcons, { recursive: true });
mkdirSync(brand, { recursive: true });

const defs = `
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.38" r="0.75">
      <stop offset="0" stop-color="#1C2636"/>
      <stop offset="0.6" stop-color="#0E131B"/>
      <stop offset="1" stop-color="#080A0E"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#81C7FF" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#81C7FF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="g" x1="20" y1="10" x2="100" y2="112" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F4F6F8"/>
      <stop offset="0.45" stop-color="#B9DCFF"/>
      <stop offset="1" stop-color="#5AA9EE"/>
    </linearGradient>
    <linearGradient id="o" x1="14" y1="70" x2="106" y2="58" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#81C7FF" stop-opacity="0.35"/>
      <stop offset="0.5" stop-color="#EAF5FF"/>
      <stop offset="1" stop-color="#81C7FF" stop-opacity="0.4"/>
    </linearGradient>
    <radialGradient id="sphere" cx="0.38" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="0.6" stop-color="#81C7FF" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#81C7FF" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

/** The emblem drawn in a 120×120 box. */
const emblem = `
  <circle cx="60" cy="60" r="49" fill="url(#sphere)"/>
  <circle cx="60" cy="60" r="49" fill="none" stroke="url(#g)" stroke-width="2.4" stroke-opacity="0.5"/>
  <path d="M30.5 96 C38 66 47 40 60 20 C73 40 82 66 89.5 96" fill="none" stroke="url(#g)" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M14 74.5 C30 62 90 54 106 61.5 C96 70 32 79 14 74.5 Z" fill="none" stroke="url(#o)" stroke-width="3.2" stroke-linejoin="round"/>
  <path d="M60 7.5 L62 13.6 L68 15.5 L62 17.4 L60 23.5 L58 17.4 L52 15.5 L58 13.6 Z" fill="#F4F6F8"/>`;

/** Square app icon. `pad` is the emblem scale inside the tile (maskable icons need a safe zone). */
function icon(size, { pad = 0.74, rounded = true, transparent = false } = {}) {
  const s = size;
  const e = s * pad;
  const off = (s - e) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${defs}
    ${transparent ? '' : `<rect width="${s}" height="${s}" rx="${rounded ? s * 0.22 : 0}" fill="url(#bg)"/>`}
    ${transparent ? '' : `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.46}" fill="url(#glow)"/>`}
    <g transform="translate(${off} ${off}) scale(${e / 120})">${emblem}</g>
  </svg>`;
}

/** Android TV banner (320×180 base) and Fire TV wide icon: emblem + wordmark. */
function banner(w, h) {
  const e = h * 0.62;
  const cx = w * 0.22;
  const textX = cx + e / 2 + w * 0.06;
  const textW = w - textX - w * 0.07;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <ellipse cx="${cx}" cy="${h / 2}" rx="${h * 0.6}" ry="${h * 0.6}" fill="url(#glow)"/>
    <g transform="translate(${cx - e / 2} ${(h - e) / 2}) scale(${e / 120})">${emblem}</g>
    <text x="${textX}" y="${h * 0.5 + h * 0.075}" textLength="${textW}" lengthAdjust="spacing" font-family="Segoe UI, Inter, Helvetica, Arial, sans-serif" font-weight="700" font-size="${h * 0.2}" fill="#F4F6F8">ATLAS</text>
  </svg>`;
}

async function png(svg, out) {
  mkdirSync(dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  console.log('wrote', out.replace(root, '.'));
}

// Web / PWA
await png(icon(192), join(webIcons, 'icon-192.png'));
await png(icon(512), join(webIcons, 'icon-512.png'));
await png(icon(512, { pad: 0.56, rounded: false }), join(webIcons, 'icon-maskable-512.png'));
await png(icon(180), join(webIcons, 'apple-touch-icon.png'));
await png(icon(32, { pad: 0.9 }), join(webIcons, 'favicon-32.png'));

// iOS app icon (Apple applies its own mask; no transparency, no rounding)
await png(icon(1024, { rounded: false }), join(brand, 'ios/AppIcon-1024.png'));

// Android legacy launcher icons + adaptive foreground/background
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(densities)) {
  await png(icon(px), join(brand, `android/mipmap-${d}/ic_launcher.png`));
  const fg = Math.round(px * 2.25); // 108dp adaptive canvas
  await png(icon(fg, { pad: 0.5, transparent: true }), join(brand, `android/mipmap-${d}/ic_launcher_foreground.png`));
  await png(`<svg xmlns="http://www.w3.org/2000/svg" width="${fg}" height="${fg}">${defs}<rect width="${fg}" height="${fg}" fill="url(#bg)"/></svg>`, join(brand, `android/mipmap-${d}/ic_launcher_background.png`));
}
await png(icon(512), join(brand, 'android/play-store-512.png'));

// Android TV launcher banner (xhdpi 320×180) and Fire TV icons
await png(banner(320, 180), join(brand, 'android-tv/banner-320x180.png'));
await png(banner(640, 360), join(brand, 'android-tv/banner-640x360.png'));
await png(banner(1280, 720), join(brand, 'fire-tv/app-icon-1280x720.png'));
await png(icon(512), join(brand, 'fire-tv/app-icon-512.png'));

// Splash / loading screen
await png(
  `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048">${defs}<rect width="2048" height="2048" fill="#080A0E"/><circle cx="1024" cy="1024" r="700" fill="url(#glow)"/><g transform="translate(784 744) scale(4)">${emblem}</g></svg>`,
  join(brand, 'splash-2048.png'),
);

writeFileSync(join(brand, 'emblem.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${defs}${emblem}</svg>`);
console.log('done');
