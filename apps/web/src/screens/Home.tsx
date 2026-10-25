import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useHome, useStatus } from '../lib/queries.ts';
import { Hero } from '../components/Hero.tsx';
import { Shelf } from '../components/Cards.tsx';
import { EmptyState, ShelfSkeleton } from '../components/Primitives.tsx';
import { focusFirst } from '../lib/focus.ts';
import { ApiError } from '../lib/api.ts';
import { IconAlert } from '../components/Icons.tsx';

export function Home() {
  const { data, isLoading, error, refetch } = useHome();
  const { data: status } = useStatus();
  const syncing = status?.sync?.running;
  const failing = status?.providers?.find((p) => p.consecutiveFailures > 0 && p.lastSuccessAt);

  useEffect(() => {
    if (data) focusFirst(document.querySelector('main') ?? document);
  }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return (
      <main>
        <div className="hero skeleton" style={{ borderRadius: 0 }} />
        <div className="rows" style={{ marginTop: '-10vh' }}>
          <ShelfSkeleton layout="landscape" count={4} />
          <ShelfSkeleton />
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="page">
        <EmptyState
          icon={(error as ApiError).data?.offline ? 'offline' : 'alert'}
          title={(error as ApiError).data?.offline ? 'You’re offline' : 'Home couldn’t load'}
          body={(error as Error).message}
          actions={
            <button className="glass-btn primary" onClick={() => refetch()}>
              Retry
            </button>
          }
        />
      </main>
    );
  }

  const empty = !data?.hero.length && !data?.rows.length;
  if (empty) {
    const noSource = !status?.providers?.length;
    const consent = status?.providers?.some((p) => p.needsHttpConsent);
    return (
      <main className="page">
        <EmptyState
          title={syncing ? 'Importing your catalogue…' : noSource ? 'Connect a content source' : consent ? 'One step left' : 'Nothing here yet'}
          body={
            syncing
              ? `${syncing.detail ?? 'Working'}. Home fills in as soon as it finishes.`
              : noSource
                ? 'Add an M3U playlist or Xtream account to start watching.'
                : consent
                  ? 'Your provider uses an unencrypted connection. Review and allow it in Settings → Content Sources.'
                  : 'Your sources haven’t provided any titles yet.'
          }
          actions={
            !syncing && (
              <Link to="/settings/sources" className="glass-btn primary" data-autofocus>
                Open Content Sources
              </Link>
            )
          }
        />
      </main>
    );
  }

  return (
    <main>
      {data!.hero.length > 0 && <Hero items={data!.hero} />}
      <div className="rows" style={data!.hero.length ? undefined : { paddingTop: 'calc(var(--nav-h) + 2rem)' }}>
        {failing && (
          <div className="banner glass" role="status">
            <IconAlert style={{ width: '1.3rem', height: '1.3rem', color: 'var(--warning)', flex: 'none' }} />
            <span className="grow">
              <strong>Couldn’t refresh {failing.name}.</strong> Showing your last saved catalogue. {failing.lastError}
            </span>
            <Link className="glass-btn sm" to="/settings/sources">
              Details
            </Link>
          </div>
        )}
        {data!.rows.map((row) => (
          <Shelf key={row.id} row={row} />
        ))}
      </div>
    </main>
  );
}
