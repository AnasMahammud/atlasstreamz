import type { SVGProps } from 'react';

/** ATLAS line icon set: 24px grid, 1.8 stroke, round caps. */
type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);
export const IconHome = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />
  </svg>
);
export const IconLive = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="6" width="18" height="12.5" rx="2.5" />
    <path d="m8.5 2.8 3.5 3.2 3.5-3.2M8 21h8" />
  </svg>
);
export const IconFilm = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
    <path d="M8 4v16M16 4v16M3.5 9H8M3.5 15H8M16 9h4.5M16 15h4.5" />
  </svg>
);
export const IconShows = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="8" width="18" height="12" rx="2.5" />
    <path d="M6 5h12M8.5 2.5h7" />
  </svg>
);
export const IconBookmark = (p: P) => (
  <svg {...base(p)}>
    <path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4-6.5 4V5a1 1 0 0 1 1-1z" />
  </svg>
);
export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 11.5A8 8 0 1 0 17.6 17.6M20 5v6.5h-6.5" />
  </svg>
);
export const IconPlay = (p: P) => (
  <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
    <path d="M7.5 4.8v14.4a1 1 0 0 0 1.52.85l11.6-7.2a1 1 0 0 0 0-1.7L9.02 3.95A1 1 0 0 0 7.5 4.8z" />
  </svg>
);
export const IconPause = (p: P) => (
  <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
    <rect x="6" y="4.5" width="4.2" height="15" rx="1.3" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.3" />
  </svg>
);
export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </svg>
);
export const IconChevronLeft = (p: P) => (
  <svg {...base(p)}>
    <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />
  </svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...base(p)}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </svg>
);
export const IconChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />
  </svg>
);
export const IconChevronUp = (p: P) => (
  <svg {...base(p)}>
    <path d="m5.5 14.5 6.5-6.5 6.5 6.5" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);
export const IconVolume = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
    <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />
  </svg>
);
export const IconMute = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </svg>
);
export const IconSubtitles = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 12.5h3M12.5 12.5H17M7 15.5h6M15 15.5h2" />
  </svg>
);
export const IconAudio = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </svg>
);
export const IconFullscreen = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </svg>
);
export const IconExitFullscreen = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" />
  </svg>
);
export const IconPip = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
export const IconBack10 = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4" />
    <text x="12" y="15.2" fontSize="6.4" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="inherit">
      10
    </text>
  </svg>
);
export const IconForward10 = (p: P) => (
  <svg {...base(p)}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
    <text x="12" y="15.2" fontSize="6.4" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="inherit">
      10
    </text>
  </svg>
);
export const IconNext = (p: P) => (
  <svg {...base(p)}>
    <path d="M5.5 5.5v13l9-6.5zM18.5 5.5v13" />
  </svg>
);
export const IconGuide = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 9h18M8.5 9v11M8.5 14.5H21" />
  </svg>
);
export const IconStar = (p: P) => (
  <svg {...base(p)}>
    <path d="m12 3.8 2.5 5.1 5.6.8-4.05 3.95.95 5.6L12 16.6l-5 2.65.95-5.6L3.9 9.7l5.6-.8z" />
  </svg>
);
export const IconLock = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </svg>
);
export const IconUser = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
  </svg>
);
export const IconEdit = (p: P) => (
  <svg {...base(p)}>
    <path d="M15.5 4.5 19.5 8.5 9 19H5v-4z" />
  </svg>
);
export const IconOffline = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.4M19 12.5a10 10 0 0 0-3.3-2.2M2 9a14.5 14.5 0 0 1 4.3-2.8M22 9a14.5 14.5 0 0 0-10-4" />
    <circle cx="12" cy="20" r=".6" fill="currentColor" />
  </svg>
);
export const IconAlert = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4 2.8 19.5h18.4z" />
    <path d="M12 10v4.5M12 17.2v.2" />
  </svg>
);
export const IconLogout = (p: P) => (
  <svg {...base(p)}>
    <path d="M14.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-3.5M10 8l-4 4 4 4M6 12h10" />
  </svg>
);
export const IconSliders = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </svg>
);
export const IconStorage = (p: P) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
    <path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
  </svg>
);
export const IconSource = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 7.5h14M5 12h14M5 16.5h8" />
    <circle cx="18" cy="17" r="2.5" />
  </svg>
);
export const IconSparkle = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.5c.5 4 2.5 6.6 7 7.5-4.5.9-6.5 3.5-7 7.5-.5-4-2.5-6.6-7-7.5 4.5-.9 6.5-3.5 7-7.5z" />
  </svg>
);
export const IconUp = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
export const IconDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);
export const IconBackspace = (p: P) => (
  <svg {...base(p)}>
    <path d="M8.5 5.5H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8.5L3 12z" />
    <path d="m11.5 9.5 5 5M16.5 9.5l-5 5" />
  </svg>
);
export const IconUpload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 16V4M7 9l5-5 5 5M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
  </svg>
);
export const IconSpeed = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 17a8 8 0 1 1 15 0" />
    <path d="m12 13 3.5-4" />
    <circle cx="12" cy="13.2" r="1.2" fill="currentColor" />
  </svg>
);
export const IconAspect = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
    <path d="M7 9.5v-1h2.5M17 14.5v1h-2.5" />
  </svg>
);
export const IconUsers = (p: P) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8.5" r="3.4" />
    <path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0" />
    <path d="M15.5 5.4a3.4 3.4 0 0 1 0 6.3M17.6 13.6a6.2 6.2 0 0 1 3.6 5.9" />
  </svg>
);
