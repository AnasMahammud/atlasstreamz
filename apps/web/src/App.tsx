import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useStatus } from './lib/queries.ts';
import { focusElement, pushBack } from './lib/focus.ts';
import { useUi } from './lib/store.ts';
import { Ambient, BottomNav, SideRail, TopNav } from './components/Nav.tsx';
import { Toasts } from './components/Primitives.tsx';
import { Startup } from './screens/Startup.tsx';
import { Login, Register, Setup } from './screens/Welcome.tsx';
import { Profiles } from './screens/Profiles.tsx';
import { Home } from './screens/Home.tsx';
import { AtlasEmblem } from './components/Brand.tsx';

const Browse = lazy(() => import('./screens/Browse.tsx'));
const MovieDetail = lazy(() => import('./screens/Details.tsx').then((m) => ({ default: m.MovieDetail })));
const SeriesDetail = lazy(() => import('./screens/Details.tsx').then((m) => ({ default: m.SeriesDetail })));
const LiveTV = lazy(() => import('./screens/Live.tsx'));
const Guide = lazy(() => import('./screens/Guide.tsx'));
const Search = lazy(() => import('./screens/Search.tsx'));
const MyList = lazy(() => import('./screens/MyList.tsx'));
const Settings = lazy(() => import('./screens/Settings.tsx'));
const Player = lazy(() => import('./screens/Player.tsx'));

function Splash() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <AtlasEmblem size={56} style={{ opacity: 0.85 }} />
    </div>
  );
}

/** Routes inside the shell need a signed-in session with a selected profile. */
function RequireProfile() {
  const { data: status, isLoading, error } = useStatus();
  const location = useLocation();
  if (isLoading) return <Splash />;
  if (error && !status) return <ServerUnreachable />;
  if (status?.setupRequired) return <Navigate to="/setup" replace />;
  if (!status?.signedIn) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!status.profile) return <Navigate to="/profiles" replace />;
  return <Outlet />;
}

function RequireSession() {
  const { data: status, isLoading, error } = useStatus();
  if (isLoading) return <Splash />;
  if (error && !status) return <ServerUnreachable />;
  if (status?.setupRequired) return <Navigate to="/setup" replace />;
  if (!status?.signedIn) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function ServerUnreachable() {
  const { refetch } = useStatus();
  return (
    <div className="welcome">
      <div className="welcome-card glass welcome-form">
        <AtlasEmblem size={56} />
        <h1 className="t-headline">Can’t reach ATLAS</h1>
        <p className="t-body">The ATLAS server isn’t responding. Check that it’s running and that this device is on the same network.</p>
        <button className="glass-btn primary" onClick={() => refetch()} data-autofocus>
          Retry
        </button>
      </div>
    </div>
  );
}

const TOP_LEVEL = ['/', '/live', '/movies', '/shows', '/my-list', '/search', '/guide', '/settings'];

/** Focus the side menu's current item (TV). */
function focusRail(): boolean {
  const rail = document.querySelector<HTMLElement>('[data-rail]');
  const target = rail?.querySelector<HTMLElement>("[aria-current='page']") ?? rail?.querySelector<HTMLElement>('a');
  return focusElement(target);
}

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const tv = useUi((s) => s.device) === 'tv';
  const topLevel = TOP_LEVEL.includes(location.pathname) || location.pathname.startsWith('/settings');
  useEffect(
    () =>
      pushBack(() => {
        // TV: Back from content on a main page moves into the side menu first, then Home, then exits.
        if (tv && topLevel && !document.querySelector('[data-rail]')?.contains(document.activeElement)) return focusRail();
        if (topLevel && location.pathname !== '/') {
          navigate('/');
          return true;
        }
        return false;
      }),
    [location.pathname, navigate, tv, topLevel],
  );
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <div className={`shell ${tv ? 'shell-tv' : ''}`}>
      {tv ? <SideRail /> : <TopNav />}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={location.pathname.split('/')[1] || 'home'} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: tv ? 0.12 : 0.18 }}>
          <Suspense fallback={<Splash />}>
            <Outlet />
          </Suspense>
        </motion.div>
      </AnimatePresence>
      {!tv && <BottomNav />}
    </div>
  );
}

export function App() {
  const [booted, setBooted] = useState(false);
  const done = useCallback(() => setBooted(true), []);
  const device = useUi((s) => s.device);
  const motionPref = useUi((s) => s.appearance.motion);
  // TVs (Fire TV sticks especially) get fades only: no springs, slides or scaling.
  const reduced = device === 'tv' || motionPref === 'reduced' ? 'always' : 'user';
  return (
    <MotionConfig reducedMotion={reduced}>
      <Ambient />
      {!booted ? (
        <Startup onDone={done} />
      ) : (
        // Opacity only: a filter or transform here would become the containing block for the
        // fixed-position nav and player.
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.45 }}>
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route element={<RequireSession />}>
              <Route path="/profiles" element={<Profiles />} />
            </Route>
            <Route element={<RequireProfile />}>
              <Route
                path="/watch/:id"
                element={
                  <Suspense fallback={<div style={{ background: '#000', position: 'fixed', inset: 0 }} />}>
                    <Player />
                  </Suspense>
                }
              />
              <Route element={<Shell />}>
                <Route path="/" element={<Home />} />
                <Route path="/movies" element={<Browse kind="movies" />} />
                <Route path="/shows" element={<Browse kind="series" />} />
                <Route path="/movie/:id" element={<MovieDetail />} />
                <Route path="/series/:id" element={<SeriesDetail />} />
                <Route path="/live" element={<LiveTV />} />
                <Route path="/guide" element={<Guide />} />
                <Route path="/search" element={<Search />} />
                <Route path="/my-list" element={<MyList />} />
                <Route path="/settings/*" element={<Settings />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </motion.div>
      )}
      <Toasts />
    </MotionConfig>
  );
}
