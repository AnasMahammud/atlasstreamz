import { LayoutGroup, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Status } from '../lib/api.ts';
import { useStatus } from '../lib/queries.ts';
import { toast, useUi } from '../lib/store.ts';
import { AtlasEmblem, Avatar } from './Brand.tsx';
import { IconBookmark, IconFilm, IconGuide, IconHome, IconLive, IconRefresh, IconSearch, IconSettings, IconShows } from './Icons.tsx';

const TABS = [
  { to: '/', label: 'Home', icon: IconHome, match: (p: string) => p === '/' },
  { to: '/live', label: 'Live TV', icon: IconLive, match: (p: string) => p.startsWith('/live') || p.startsWith('/guide') },
  { to: '/movies', label: 'Movies', icon: IconFilm, match: (p: string) => p.startsWith('/movies') || p.startsWith('/movie/') },
  { to: '/shows', label: 'TV Shows', icon: IconShows, match: (p: string) => p.startsWith('/shows') || p.startsWith('/series/') },
  { to: '/my-list', label: 'My List', icon: IconBookmark, match: (p: string) => p.startsWith('/my-list') },
];

const spring = { type: 'spring' as const, stiffness: 520, damping: 40, mass: 0.8 };

/** AtlasNavigationRail (desktop/TV): floating glass pill, centred, after the reference design. */
export function TopNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { data: status } = useStatus();
  const [scrolled, setScrolled] = useState(false);
  const [deep, setDeep] = useState(false);
  const [navFocused, setNavFocused] = useState(false);
  const device = useUi((s) => s.device);
  const profile = status?.profile;

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 24);
      setDeep(window.scrollY > 220);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // On TVs the nav steps aside while you browse rows, like Apple TV; focusing it brings it back.
  const hidden = device === 'tv' && deep && !navFocused;

  return (
    <header
      className="topnav"
      data-scrolled={scrolled}
      data-hidden={hidden}
      data-reveal-top
      onFocus={() => setNavFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setNavFocused(false);
      }}
    >
      <div className="nav-left">
        <Link to="/" className="brand" aria-label="ATLAS home" data-focusable>
          <AtlasEmblem size={34} />
          <span className="brand-word">ATLAS</span>
        </Link>
      </div>
      <LayoutGroup id="topnav">
        <nav className="nav-pill glass" aria-label="Main">
          <Link to="/search" className="nav-tab icon-only" aria-label="Search" aria-current={pathname.startsWith('/search') ? 'page' : undefined} data-focusable>
            {pathname.startsWith('/search') && <motion.span layoutId="nav-ind" className="nav-indicator" transition={spring} />}
            <IconSearch />
          </Link>
          {TABS.map((t) => {
            const active = t.match(pathname);
            return (
              <Link key={t.to} to={t.to} className="nav-tab" aria-current={active ? 'page' : undefined} data-focusable>
                {active && <motion.span layoutId="nav-ind" className="nav-indicator" transition={spring} />}
                {t.label}
              </Link>
            );
          })}
          <Link to="/guide" className="nav-tab icon-only" aria-label="Programme guide" aria-current={pathname.startsWith('/guide') ? 'page' : undefined} data-focusable>
            {pathname.startsWith('/guide') && <motion.span layoutId="nav-ind" className="nav-indicator" transition={spring} />}
            <IconGuide />
          </Link>
        </nav>
      </LayoutGroup>
      <div className="nav-right">
        <SyncButton status={status} />
        <Link to="/settings" className="glass-btn icon hide-mobile" aria-label="Settings" data-focusable>
          <IconSettings />
        </Link>
        {profile && (
          <button className="avatar-btn glass" onClick={() => navigate('/profiles')} aria-label={`Profile: ${profile.name}. Switch profile`}>
            <Avatar avatar={profile.avatar} name={profile.name} size={36} />
            <span className="name">{profile.name}</span>
          </button>
        )}
      </div>
    </header>
  );
}

function SyncButton({ status }: { status?: Status }) {
  const qc = useQueryClient();
  const running = !!status?.sync?.running;
  const failing = status?.providers?.some((p) => p.consecutiveFailures > 0);
  const refresh = async () => {
    const providers = status?.providers?.filter((p) => p.enabled && !p.needsHttpConsent) ?? [];
    if (!providers.length) {
      toast('Add a content source in Settings first.');
      return;
    }
    if (running) {
      toast(`Refreshing… ${status?.sync?.running?.detail ?? ''}`);
      return;
    }
    for (const p of providers) await api.post(`/api/providers/${p.id}/sync`).catch(() => null);
    toast('Refreshing your sources. You can keep watching.');
    void qc.invalidateQueries({ queryKey: ['status'] });
  };
  return (
    <button className="glass-btn icon hide-mobile" onClick={refresh} aria-label={running ? 'Refreshing sources' : failing ? 'Last refresh failed — retry' : 'Refresh sources'} title={running ? status?.sync?.running?.detail : 'Refresh sources'}>
      <IconRefresh className={running ? 'spin-slow' : undefined} />
      {failing && !running && <span className="sync-dot" />}
    </button>
  );
}

/**
 * TV navigation: a left rail that is always on screen (Android TV / Fire TV convention). It
 * shows icons; moving left into it expands it with labels. Entering it always lands on the
 * current page's item, and Back from any top-level page returns focus here.
 */
export function SideRail() {
  const { pathname } = useLocation();
  const { data: status } = useStatus();
  const profile = status?.profile;
  const items = [
    { to: '/search', label: 'Search', icon: IconSearch, active: pathname.startsWith('/search') },
    { to: '/', label: 'Home', icon: IconHome, active: pathname === '/' },
    { to: '/live', label: 'Live TV', icon: IconLive, active: pathname.startsWith('/live') },
    { to: '/guide', label: 'Guide', icon: IconGuide, active: pathname.startsWith('/guide') },
    { to: '/movies', label: 'Movies', icon: IconFilm, active: pathname.startsWith('/movies') || pathname.startsWith('/movie/') },
    { to: '/shows', label: 'TV Shows', icon: IconShows, active: pathname.startsWith('/shows') || pathname.startsWith('/series/') },
    { to: '/my-list', label: 'My List', icon: IconBookmark, active: pathname.startsWith('/my-list') },
    { to: '/settings', label: 'Settings', icon: IconSettings, active: pathname.startsWith('/settings') },
  ];
  return (
    <nav className="side-rail" aria-label="Main" data-focus-zone="rail" data-focus-enter="[aria-current='page']" data-rail>
      <div className="rail-brand" aria-hidden="true">
        <AtlasEmblem size={40} />
      </div>
      <div className="rail-items">
        {items.map((i) => (
          <Link key={i.to} to={i.to} className="rail-link" aria-current={i.active ? 'page' : undefined} data-focusable>
            <i.icon />
            <span className="rail-label">{i.label}</span>
          </Link>
        ))}
      </div>
      {profile && (
        <Link to="/profiles" className="rail-link rail-profile" aria-label={`Profile: ${profile.name}. Switch profile`} data-focusable>
          <Avatar avatar={profile.avatar} name={profile.name} size={34} />
          <span className="rail-label">{profile.name}</span>
        </Link>
      )}
    </nav>
  );
}

/** AtlasBottomNavigation (phones). */
export function BottomNav() {
  const { pathname } = useLocation();
  const items = [
    { to: '/', label: 'Home', icon: IconHome, active: pathname === '/' },
    { to: '/live', label: 'Live', icon: IconLive, active: pathname.startsWith('/live') || pathname.startsWith('/guide') },
    { to: '/movies', label: 'Movies', icon: IconFilm, active: pathname.startsWith('/movie') },
    { to: '/shows', label: 'Shows', icon: IconShows, active: pathname.startsWith('/shows') || pathname.startsWith('/series') },
    { to: '/search', label: 'Search', icon: IconSearch, active: pathname.startsWith('/search') },
    { to: '/my-list', label: 'My List', icon: IconBookmark, active: pathname.startsWith('/my-list') },
  ];
  return (
    <LayoutGroup id="bottomnav">
      <nav className="bottomnav glass" aria-label="Main">
        {items.map((i) => (
          <Link key={i.to} to={i.to} aria-current={i.active ? 'page' : undefined}>
            {i.active && <motion.span layoutId="bn-ind" className="bn-indicator" transition={spring} />}
            <i.icon />
            {i.label}
          </Link>
        ))}
      </nav>
    </LayoutGroup>
  );
}

export function Ambient() {
  const image = useUi((s) => s.ambientImage);
  const device = useUi((s) => s.device);
  const [layers, setLayers] = useState<Array<{ key: number; url?: string }>>([{ key: 0, url: undefined }]);
  useEffect(() => {
    if (device === 'tv') return;
    setLayers((l) => [...l.slice(-1), { key: (l[l.length - 1]?.key ?? 0) + 1, url: image }]);
  }, [image, device]);
  return (
    <div className="ambient" aria-hidden="true">
      {layers.map((l, i) => (
        <AmbientLayer key={l.key} url={l.url} on={i === layers.length - 1} />
      ))}
    </div>
  );
}

function AmbientLayer({ url, on }: { url?: string; on: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(on));
    return () => cancelAnimationFrame(t);
  }, [on]);
  if (!url) return null;
  const small = url.includes('image.tmdb.org') ? url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, '$1w300/') : url;
  return <div className={`ambient-art ${shown && on ? 'on' : ''}`} style={{ backgroundImage: `url("${small}")` }} />;
}
