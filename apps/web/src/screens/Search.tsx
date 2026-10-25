import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, enc, type Card } from '../lib/api.ts';
import { Shelf } from '../components/Cards.tsx';
import { EmptyState } from '../components/Primitives.tsx';
import { IconBackspace, IconClose, IconSearch } from '../components/Icons.tsx';
import { useUi } from '../lib/store.ts';
import { focusFirst } from '../lib/focus.ts';

interface SearchResult {
  query: string;
  results: Card[];
  history?: string[];
  categories?: Array<{ id: string; name: string; kind: 'live' | 'movie' | 'series' }>;
  suggestions?: string[];
}

const KEYS = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('');

/** Universal search: instant, typo-tolerant, grouped by type, with a remote-friendly keyboard on TVs. */
export default function Search() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(text);
  const [kind, setKind] = useState<'all' | 'movie' | 'series' | 'live'>('all');
  const device = useUi((s) => s.device);
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 180);
    return () => window.clearTimeout(t);
  }, [text]);

  useEffect(() => {
    setParams(debounced ? { q: debounced } : {}, { replace: true });
    if (debounced.trim().length >= 3) {
      const t = window.setTimeout(() => api.post('/api/search/history', { query: debounced }).catch(() => null), 1500);
      return () => window.clearTimeout(t);
    }
  }, [debounced, setParams]);

  useEffect(() => {
    if (device === 'tv') focusFirst(document.querySelector('.tv-keyboard') ?? document);
    else input.current?.focus();
  }, [device]);

  const { data, isFetching, error } = useQuery({
    queryKey: ['search', debounced, kind],
    queryFn: ({ signal }) => api.get<SearchResult>(`/api/search?q=${enc(debounced)}${kind !== 'all' ? `&kind=${kind}` : ''}`, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const groups = useMemo(() => {
    const r = data?.results ?? [];
    return {
      movies: r.filter((c) => c.kind === 'movie'),
      series: r.filter((c) => c.kind === 'series'),
      live: r.filter((c) => c.kind === 'live'),
    };
  }, [data]);

  const type = (k: string) => setText((t) => (t + k).slice(0, 60));
  const total = data?.results.length ?? 0;

  return (
    <main className="page search-page">
      <div className={`search-top ${device === 'tv' ? 'with-keyboard' : ''}`}>
        <div className="search-field glass">
          <IconSearch />
          <input
            ref={input}
            className="search-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Movies, shows, channels, genres"
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          {isFetching && <span className="spinner" style={{ width: '1.2rem', height: '1.2rem', borderWidth: 2 }} />}
          {text && (
            <button className="glass-btn icon sm" onClick={() => setText('')} aria-label="Clear search" style={{ width: '2.2rem' }}>
              <IconClose />
            </button>
          )}
        </div>
        {device === 'tv' && (
          <div className="tv-keyboard" role="group" aria-label="On-screen keyboard" data-focus-zone="keyboard">
            {KEYS.map((k, i) => (
              <button key={k} className="key" onClick={() => type(k)} data-autofocus={i === 0 ? true : undefined}>
                {k}
              </button>
            ))}
            <button className="key wide" onClick={() => type(' ')}>
              Space
            </button>
            <button className="key wide" onClick={() => setText((t) => t.slice(0, -1))} aria-label="Delete">
              <IconBackspace />
            </button>
            <button className="key wide" onClick={() => setText('')}>
              Clear
            </button>
          </div>
        )}
        <div className="chip-rail no-scrollbar" role="toolbar" aria-label="Filter results" data-focus-zone="search-filters">
          {(['all', 'movie', 'series', 'live'] as const).map((k) => (
            <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === 'all' ? 'Everything' : k === 'movie' ? 'Movies' : k === 'series' ? 'TV Shows' : 'Live channels'}
            </button>
          ))}
        </div>
      </div>

      {!debounced.trim() ? (
        <section className="search-idle">
          {data?.history?.length ? (
            <>
              <div className="row-head" style={{ padding: 0 }}>
                <h2 className="t-section">Recent searches</h2>
                <button
                  className="see-all"
                  onClick={async () => {
                    await api.del('/api/search/history');
                    void qc.invalidateQueries({ queryKey: ['search'] });
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="chip-rail wrap">
                {data.history.map((h) => (
                  <button key={h} className="chip" onClick={() => setText(h)}>
                    {h}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <EmptyState title="Find anything" body="Search across every movie, series and live channel from your sources. Spelling doesn’t have to be perfect." />
          )}
        </section>
      ) : error ? (
        <EmptyState icon="alert" title="Search failed" body={(error as Error).message} />
      ) : total === 0 && !isFetching ? (
        <EmptyState
          title={`No results for “${debounced}”`}
          body={data?.suggestions?.length ? 'Did you mean one of these?' : 'Try a different spelling, or search for a channel or genre.'}
          actions={data?.suggestions?.map((s) => (
            <button key={s} className="chip" onClick={() => setText(s)}>
              {s}
            </button>
          ))}
        />
      ) : (
        <div className="rows search-results">
          {data?.categories && data.categories.length > 0 && (
            <section>
              <div className="row-head">
                <h2 className="t-section">Categories</h2>
              </div>
              <div className="chip-rail no-scrollbar" style={{ padding: '0 var(--gutter)' }} data-focus-zone="search-cats">
                {data.categories.map((c) => (
                  <Link key={c.id} className="chip" to={c.kind === 'live' ? `/live?category=${enc(c.id)}` : `/${c.kind === 'movie' ? 'movies' : 'shows'}?category=${enc(c.id)}`}>
                    {c.name}
                    <span className="count">{c.kind === 'live' ? 'Live' : c.kind === 'movie' ? 'Movies' : 'Shows'}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {groups.movies.length > 0 && <Shelf row={{ id: 's-movies', title: 'Movies', layout: 'poster', items: groups.movies }} />}
          {groups.series.length > 0 && <Shelf row={{ id: 's-series', title: 'TV Shows', layout: 'poster', items: groups.series }} />}
          {groups.live.length > 0 && <Shelf row={{ id: 's-live', title: 'Live Channels', layout: 'channel', items: groups.live }} />}
        </div>
      )}
    </main>
  );
}
