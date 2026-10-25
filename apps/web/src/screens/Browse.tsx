import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { GENRE_LABELS } from '@atlas/core';
import { useBrowse, useCategories } from '../lib/queries.ts';
import { PosterCard } from '../components/Cards.tsx';
import { EmptyState } from '../components/Primitives.tsx';
import { focusFirst } from '../lib/focus.ts';

const SORTS = [
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'A–Z' },
  { value: 'year', label: 'Release year' },
  { value: 'rating', label: 'Provider rating' },
];

const DECADES = [
  { label: 'Any year' },
  { label: '2020s', from: 2020, to: 2029 },
  { label: '2010s', from: 2010, to: 2019 },
  { label: '2000s', from: 2000, to: 2009 },
  { label: '1990s', from: 1990, to: 1999 },
  { label: 'Earlier', from: 1900, to: 1989 },
];

/** Movies and TV Shows catalogue: genre/category chips, sort, decade filter, virtualised grid. */
export default function Browse({ kind }: { kind: 'movies' | 'series' }) {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? undefined;
  const genre = params.get('genre') ?? undefined;
  const sort = params.get('sort') ?? 'added';
  const decade = Number(params.get('decade') ?? 0);
  const d = DECADES[decade] ?? DECADES[0];
  const { data: cats } = useCategories(kind === 'movies' ? 'movie' : 'series');
  const query = useBrowse(kind, { category, genre, sort, yearFrom: d.from, yearTo: d.to });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  // Show regionless categories first; regional ones are grouped after.
  const chips = useMemo(() => {
    const list = cats ?? [];
    return [...list.filter((c) => !c.region), ...list.filter((c) => c.region)];
  }, [cats]);

  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => focusFirst(document.querySelector('main') ?? document), [kind]);

  const title = kind === 'movies' ? 'Movies' : 'TV Shows';
  const activeLabel = category ? cats?.find((c) => c.id === category)?.name : genre ? GENRE_LABELS[genre] : undefined;

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1 className="t-headline">{activeLabel ?? title}</h1>
          <p className="t-caption" style={{ marginTop: '0.4rem' }}>
            {query.isLoading ? 'Loading…' : `${total.toLocaleString()} ${kind === 'movies' ? 'movies' : 'series'}`}
            {activeLabel && ` · ${title}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <select className="input select" value={sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select className="input select" value={decade} onChange={(e) => set({ decade: e.target.value === '0' ? undefined : e.target.value })} aria-label="Release year">
            {DECADES.map((x, i) => (
              <option key={x.label} value={i}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="chip-rail no-scrollbar" data-shelf data-focus-zone={`${kind}-cats`} role="toolbar" aria-label="Categories">
        <button className="chip" aria-pressed={!category && !genre} onClick={() => set({ category: undefined, genre: undefined })} data-autofocus>
          All
        </button>
        {chips.map((c) => (
          <button key={c.id} className="chip" aria-pressed={category === c.id} onClick={() => set({ category: c.id, genre: undefined })}>
            {c.name}
            <span className="count">{c.count.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {query.isError ? (
        <EmptyState icon="alert" title="Couldn’t load this catalogue" body={(query.error as Error).message} actions={<button className="glass-btn primary" onClick={() => query.refetch()}>Retry</button>} />
      ) : !query.isLoading && items.length === 0 ? (
        <EmptyState title="Nothing matches" body="Try another category or year." />
      ) : (
        <VirtualGrid items={items} hasMore={!!query.hasNextPage} loading={query.isFetchingNextPage || query.isLoading} loadMore={() => query.fetchNextPage()} />
      )}
    </main>
  );
}

function useColumns(ref: React.RefObject<HTMLElement>): { cols: number; width: number } {
  const [state, setState] = useState({ cols: 6, width: 1200 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const min = window.innerWidth <= 820 ? 7 * rem : Math.min(15 * rem, Math.max(7.5 * rem, window.innerWidth * 0.112));
      const gap = window.innerWidth <= 820 ? 0.75 * rem : Math.min(1.5 * rem, Math.max(0.75 * rem, window.innerWidth * 0.014));
      const cols = window.innerWidth <= 820 ? 3 : Math.max(2, Math.floor((w + gap) / (min + gap)));
      setState({ cols, width: w });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return state;
}

export function VirtualGrid({ items, hasMore, loading, loadMore }: { items: import('../lib/api.ts').Card[]; hasMore: boolean; loading: boolean; loadMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { cols, width } = useColumns(ref);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const gap = window.innerWidth <= 820 ? 0.75 * rem : Math.min(1.5 * rem, Math.max(0.75 * rem, window.innerWidth * 0.014));
  const cardW = (width - gap * (cols - 1)) / cols;
  const rowH = cardW * 1.5 + 3.6 * rem;
  const rows = Math.ceil(items.length / cols) + (hasMore ? 1 : 0);
  const virt = useWindowVirtualizer({ count: rows, estimateSize: () => rowH, overscan: 3, scrollMargin: ref.current?.offsetTop ?? 0 });
  const vItems = virt.getVirtualItems();

  useEffect(() => {
    virt.measure();
  }, [rowH, virt]);

  useEffect(() => {
    const last = vItems[vItems.length - 1];
    if (last && last.index >= rows - 3 && hasMore && !loading) loadMore();
  }, [vItems, rows, hasMore, loading, loadMore]);

  return (
    <div ref={ref} style={{ position: 'relative', height: virt.getTotalSize(), marginTop: '1.5rem' }} data-focus-zone="grid">
      {vItems.map((v) => {
        const slice = items.slice(v.index * cols, v.index * cols + cols);
        return (
          <div
            key={v.key}
            className="vgrid-row"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${v.start - virt.options.scrollMargin}px)`,
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap,
              height: rowH,
            }}
          >
            {slice.length
              ? slice.map((c) => <PosterCard key={c.id} card={c} />)
              : Array.from({ length: cols }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: '2 / 3' }} />)}
          </div>
        );
      })}
    </div>
  );
}
