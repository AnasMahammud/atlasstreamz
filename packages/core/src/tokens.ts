/**
 * ATLAS design tokens. Platform-neutral numbers and colours; the web app maps them to CSS
 * custom properties and native apps can map them to their style systems.
 */
export const colors = {
  obsidian: '#080A0E',
  graphite: '#11151B',
  graphiteRaised: '#171C24',
  softWhite: '#F4F6F8',
  silver: '#CAD5E2',
  ice: '#81C7FF',
  iceDeep: '#3D8FD6',
  live: '#FF4D5E',
  fresh: '#FF9F43',
  success: '#5BE0A0',
  warning: '#FFC861',
  danger: '#FF6B7A',
} as const;

export const glass = {
  /** Fill opacity of glass over dark artwork. */
  fill: 0.09,
  fillStrong: 0.16,
  border: 0.16,
  highlight: 0.32,
  blurPx: 28,
  blurStrongPx: 48,
  saturate: 1.7,
} as const;

export const radii = { xs: 8, sm: 12, md: 18, lg: 24, xl: 32, pill: 999 } as const;

/** 4-pt spacing scale (in px at 1x / desktop density). */
export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96] as const;

export const motion = {
  /** Spring presets (stiffness, damping, mass) shared by web (framer-motion) and native (Reanimated). */
  spring: {
    focus: { stiffness: 420, damping: 32, mass: 0.9 },
    page: { stiffness: 260, damping: 30, mass: 1 },
    gentle: { stiffness: 160, damping: 24, mass: 1 },
    snappy: { stiffness: 600, damping: 40, mass: 0.8 },
  },
  durationMs: { fast: 140, base: 240, slow: 420, ambient: 900 },
  easing: {
    standard: [0.2, 0, 0, 1] as const,
    emphasized: [0.05, 0.7, 0.1, 1] as const,
    exit: [0.3, 0, 0.8, 0.15] as const,
  },
} as const;

export const type = {
  family: '"Inter Variable", "SF Pro Display", -apple-system, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
  scale: { caption: 13, body: 16, bodyLarge: 18, title: 22, section: 30, headline: 44, display: 72 },
  weight: { regular: 450, medium: 550, semibold: 640, bold: 740 },
} as const;
