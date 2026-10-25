import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Card } from '../lib/api.ts';
import { ChannelTile, PosterCard } from '../components/Cards.tsx';
import { EmptyState } from '../components/Primitives.tsx';
import { focusFirst } from '../lib/focus.ts';

export default function MyList() {
  const { data, isLoading } = useQuery({ queryKey: ['my-list'], queryFn: ({ signal }) => api.get<{ items: Card[] }>('/api/me/list', signal) });
  const items = data?.items ?? [];
  const titles = items.filter((c) => c.kind !== 'live');
  const channels = items.filter((c) => c.kind === 'live');
  useEffect(() => {
    if (data) focusFirst(document.querySelector('main') ?? document);
  }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <main className="page">
      <div className="page-header">
        <h1 className="t-headline">My List</h1>
      </div>
      {isLoading ? null : !items.length ? (
        <EmptyState title="Your list is empty" body="Add movies, shows and favourite channels and they’ll wait for you here, on every device." actions={<Link to="/" className="glass-btn primary">Discover something</Link>} />
      ) : (
        <div style={{ display: 'grid', gap: '2.5rem' }}>
          {titles.length > 0 && (
            <section>
              <h2 className="t-section" style={{ marginBottom: '1rem' }}>
                Movies &amp; Shows
              </h2>
              <div className="grid" data-focus-zone="list-titles">
                {titles.map((c) => (
                  <PosterCard key={c.id} card={c} />
                ))}
              </div>
            </section>
          )}
          {channels.length > 0 && (
            <section>
              <h2 className="t-section" style={{ marginBottom: '1rem' }}>
                Favourite Channels
              </h2>
              <div className="grid channels" data-focus-zone="list-channels">
                {channels.map((c) => (
                  <ChannelTile key={c.id} card={c} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
