import { useId, type CSSProperties } from 'react';

/**
 * The ATLAS emblem: a globe whose meridians converge into an "A", crossed by a tilted
 * orbit for the crossbar, with a navigation star at the apex. Exploration, connected
 * worlds, discovery — drawn in glass.
 *
 * `draw` exposes path classes so the startup animation can trace the contours.
 */
export function AtlasEmblem({ size = 40, draw = false, style }: { size?: number; draw?: boolean; style?: CSSProperties }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" style={style} aria-hidden="true" className={draw ? 'emblem draw' : 'emblem'}>
      <defs>
        <linearGradient id={`g-${id}`} x1="20" y1="10" x2="100" y2="112" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F4F6F8" />
          <stop offset="0.45" stopColor="#B9DCFF" />
          <stop offset="1" stopColor="#5AA9EE" />
        </linearGradient>
        <linearGradient id={`o-${id}`} x1="14" y1="70" x2="106" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#81C7FF" stopOpacity="0.15" />
          <stop offset="0.5" stopColor="#E9F4FF" />
          <stop offset="1" stopColor="#81C7FF" stopOpacity="0.2" />
        </linearGradient>
        <radialGradient id={`f-${id}`} cx="0.38" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.32" />
          <stop offset="0.55" stopColor="#81C7FF" stopOpacity="0.08" />
          <stop offset="1" stopColor="#81C7FF" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* glass sphere */}
      <circle className="e-fill" cx="60" cy="60" r="49" fill={`url(#f-${id})`} />
      <circle className="e-path e-ring" cx="60" cy="60" r="49" fill="none" stroke={`url(#g-${id})`} strokeWidth="2.4" strokeOpacity="0.55" pathLength={1} />
      {/* meridians forming the A */}
      <path className="e-path e-a" d="M30.5 96 C38 66 47 40 60 20 C73 40 82 66 89.5 96" fill="none" stroke={`url(#g-${id})`} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
      {/* orbit crossbar */}
      <path className="e-path e-orbit" d="M14 74.5 C30 62 90 54 106 61.5 C96 70 32 79 14 74.5 Z" fill="none" stroke={`url(#o-${id})`} strokeWidth="3" strokeLinejoin="round" pathLength={1} />
      {/* north star */}
      <path className="e-star" d="M60 7.5 L62 13.6 L68 15.5 L62 17.4 L60 23.5 L58 17.4 L52 15.5 L58 13.6 Z" fill="#F4F6F8" />
    </svg>
  );
}

export function AtlasWordmark({ size = 1 }: { size?: number }) {
  return (
    <span className="brand-word" style={{ fontSize: `${0.92 * size}rem` }}>
      ATLAS
    </span>
  );
}

/* ---------------- Avatars ---------------- */

const AVATAR_PALETTES: Record<string, [string, string, string]> = {
  aurora: ['#7CF5D4', '#5A8CFF', '#B266FF'],
  nebula: ['#FF8AD8', '#8B5CFF', '#2B1E6B'],
  tide: ['#7FD3FF', '#2E7BEF', '#0B2C6B'],
  ember: ['#FFD27A', '#FF6A3D', '#7A1E3A'],
  meadow: ['#E5FF8A', '#43C67A', '#0F5A4A'],
  dusk: ['#FFB199', '#C2569B', '#2D1F5E'],
  glacier: ['#F4F6F8', '#A9C9E8', '#4F7396'],
  orbit: ['#81C7FF', '#2A3A5A', '#0A0F18'],
};

export function avatarColor(name: string): string {
  return AVATAR_PALETTES[name]?.[1] ?? '#81C7FF';
}

/** A liquid-glass orb avatar: layered gradients with a specular highlight and an initial. */
export function Avatar({ avatar, name, size = 44 }: { avatar: string; name: string; size?: number }) {
  const id = useId().replace(/:/g, '');
  const [a, b, c] = AVATAR_PALETTES[avatar] ?? AVATAR_PALETTES.tide;
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ flex: 'none', display: 'block' }}>
      <defs>
        <radialGradient id={`b-${id}`} cx="0.3" cy="0.25" r="0.95">
          <stop offset="0" stopColor={a} />
          <stop offset="0.55" stopColor={b} />
          <stop offset="1" stopColor={c} />
        </radialGradient>
        <radialGradient id={`s-${id}`} cx="0.32" cy="0.18" r="0.42">
          <stop offset="0" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`r-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.7" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="49" fill={`url(#b-${id})`} />
      <ellipse cx="68" cy="74" rx="30" ry="18" fill={c} opacity="0.35" />
      <circle cx="50" cy="50" r="49" fill={`url(#s-${id})`} />
      <circle cx="50" cy="50" r="48.2" fill="none" stroke={`url(#r-${id})`} strokeWidth="1.6" />
      <text x="50" y="62" textAnchor="middle" fontSize="36" fontWeight="720" fill="#fff" fillOpacity="0.92" style={{ fontFamily: 'var(--font)', letterSpacing: '-0.02em' }}>
        {initial}
      </text>
    </svg>
  );
}
