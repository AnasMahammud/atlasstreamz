import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { api, type Card, type Category } from '../lib/api.ts';
import { useBrowse, useCategories } from '../lib/queries.ts';
import { ChannelTile } from '../components/Cards.tsx';
import { EmptyState } from '../components/Primitives.tsx';
import { IconGuide, IconSearch, IconStar } from '../components/Icons.tsx';
import { focusFirst } from '../lib/focus.ts';
import { normalizeKey } from '@atlas/core';

/**
 * Live TV: a category rail and a channel wall with now-playing and live progress.
 * "Favourites" and "Recently watched" are pinned at the top of the rail.
 */
export default function LiveTV() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: cats = [] } = useCategories('live');
  const { data: liveHome } = useQuery({ queryKey: ['live-home'], queryFn: ({ signal }) => api.get<{ favourites: Card[]; recent: Card[]; categories: Category[] }>('/api/live/home', signal) });
  const [filter, setFilter] = useState('');

  const genre = params.get('genre');

  const railCats = useMemo(() => {
    const q = normalizeKey(filter);
    const list = q ? cats.filter((c) => normalizeKey(c.name).includes(q)) : cats;
    return genre ? list.filter((c) => c.genre === genre) : list;
  }, [cats, filter, genre]);

  // A genre link (e.g. Home → Live Sports) opens that genre's best-covered category.
  const genreDefault = genre ? [...railCats].sort((a, b) => (b.guideCount ?? 0) - (a.guideCount ?? 0))[0]?.id : undefined;
  const selected = params.get('category') ?? genreDefault ?? (liveHome?.favourites.length ? 'favourites' : liveHome?.recent.length ? 'recent' : cats[0]?.id);

  useEffect(() => {
    if (liveHome) focusFirst(document.querySelector('main') ?? document);
  }, [!!liveHome]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('category', id);
    setParams(next, { replace: true });
  };

  const special: Array<{ id: string; label: string; items?: Card[] }> = [
    { id: 'favourites', label: 'Favourites', items: liveHome?.favourites },
    { id: 'recent', label: 'Recently watched', items: liveHome?.recent },
  ];
  const specialSel = special.find((s) => s.id === selected);
  const catName = specialSel?.label ?? cats.find((c) => c.id === selected)?.name ?? 'Live TV';

  return (
    <main className="page live-page">
      <aside className="live-rail glass" aria-label="Channel categories">
        <div className="rail-search">
          <IconSearch />
          <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a category" aria-label="Filter categories" />
        </div>
        <div className="rail-list" data-scroll-y data-focus-zone="live-rail" role="listbox" aria-label="Categories">
          {special.map((s) => (
            <button key={s.id} role="option" aria-selected={selected === s.id} className="rail-item" onClick={() => choose(s.id)} data-autofocus={selected === s.id ? true : undefined}>
              {s.id === 'favourites' && <IconStar />}
              <span className="name">{s.label}</span>
              <span className="count">{s.items?.length ?? 0}</span>
            </button>
          ))}
          <div className="rail-sep" />
          {genre && (
            <button className="rail-item subtle" onClick={() => setParams({}, { replace: true })}>
              <span className="name">Show all categories</span>
            </button>
          )}
          {railCats.map((c) => (
            <button key={c.id} role="option" aria-selected={selected === c.id} className="rail-item" onClick={() => choose(c.id)} data-autofocus={selected === c.id ? true : undefined}>
              <span className="name">{c.name}</span>
              <span className="count">{c.count}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="live-main">
        <div className="page-header" style={{ marginBottom: '1.25rem' }}>
          <div>
            <span className="t-eyebrow">Live TV</span>
            <h1 className="t-headline" style={{ marginTop: '0.3rem' }}>
              {catName}
            </h1>
          </div>
          <Link className="glass-btn" to={`/guide${selected && !specialSel ? `?category=${encodeURIComponent(selected)}` : ''}`}>
            <IconGuide /> Guide
          </Link>
        </div>
        {specialSel ? (
          specialSel.items?.length ? (
            <div className="grid channels" data-focus-zone={`live-${specialSel.id}`}>
              {specialSel.items.map((c) => (
                <ChannelTile key={c.id} card={c} />
              ))}
            </div>
          ) : (
            <EmptyState
              title={specialSel.id === 'favourites' ? 'No favourite channels yet' : 'Nothing watched yet'}
              body={specialSel.id === 'favourites' ? 'Open a channel and choose “Add to Favourites” from the player to pin it here.' : 'Channels you watch appear here.'}
              actions={
                cats[0] && (
                  <button className="glass-btn" onClick={() => choose(cats[0].id)}>
                    Browse {cats[0].name}
                  </button>
                )
              }
            />
          )
        ) : selected ? (
          <ChannelWall category={selected} onEmpty={() => navigate('/live')} />
        ) : (
          <EmptyState title="Choose a category" body="Pick a category on the left to see its channels." />
        )}
      </section>
    </main>
  );
}

function ChannelWall({ category }: { category: string; onEmpty: () => void }) {
  const query = useBrowse('channels', { category });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const minW = window.innerWidth <= 820 ? 10 * rem : 13 * rem;
  const gap = Math.max(0.75 * rem, Math.min(1.5 * rem, window.innerWidth * 0.014));
  const cols = Math.max(2, Math.floor((width + gap) / (minW + gap)));
  const tileW = (width - gap * (cols - 1)) / cols;
  const rowH = tileW * 0.625 + gap * 1.2;
  const hasMore = !!query.hasNextPage;
  const rows = Math.ceil(items.length / cols) + (hasMore ? 1 : 0);
  const virt = useWindowVirtualizer({ count: rows, estimateSize: () => rowH, overscan: 3, scrollMargin: ref.current?.offsetTop ?? 0 });
  const vItems = virt.getVirtualItems();
  useEffect(() => virt.measure(), [rowH, virt]);
  useEffect(() => {
    const last = vItems[vItems.length - 1];
    if (last && last.index >= rows - 3 && hasMore && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [vItems, rows, hasMore, query]);

  if (query.isError) return <EmptyState icon="alert" title="Couldn’t load channels" body={(query.error as Error).message} actions={<button className="glass-btn primary" onClick={() => query.refetch()}>Retry</button>} />;
  if (!query.isLoading && !items.length) return <EmptyState title="No channels here" body="This category is empty right now." />;

  return (
    <div ref={ref} style={{ position: 'relative', height: virt.getTotalSize() }} data-focus-zone={`wall-${category}`}>
      {vItems.map((v) => {
        const slice = items.slice(v.index * cols, v.index * cols + cols);
        return (
          <div
            key={v.key}
            className="vgrid-row channels"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start - virt.options.scrollMargin}px)`, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap }}
          >
            {slice.length ? slice.map((c) => <ChannelTile key={c.id} card={c} />) : Array.from({ length: cols }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: '16 / 10' }} />)}
          </div>
        );
      })}
    </div>
  );
}
