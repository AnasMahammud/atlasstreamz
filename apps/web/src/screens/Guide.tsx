import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { enc, type Card, type Programme } from '../lib/api.ts';
import { useCategories, useGuide } from '../lib/queries.ts';
import { art } from '../lib/img.ts';
import { Dialog, EmptyState, Img, timeLabel, useNow } from '../components/Primitives.tsx';
import { IconChevronLeft, IconChevronRight, IconPlay } from '../components/Icons.tsx';
import { focusFirst } from '../lib/focus.ts';

const SLOT_MIN = 30;
const WINDOW_H = 6;

function floorToSlot(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
  return d.getTime();
}

/**
 * AtlasProgramGuide: a virtualised timeline. Channels scroll vertically (only visible rows
 * render), time scrolls horizontally in 2-hour steps. The focused programme is previewed in
 * the header, Apple TV-style; selecting something on now plays it.
 */
export default function Guide() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: cats = [] } = useCategories('live');
  // Open on the category with the richest guide data rather than one with no listings.
  const bestGuide = useMemo(() => [...cats].sort((a, b) => (b.guideCount ?? 0) - (a.guideCount ?? 0))[0], [cats]);
  const category = params.get('category') ?? bestGuide?.id;
  const now = useNow(30_000);
  const [start, setStart] = useState(() => floorToSlot(Date.now()) - SLOT_MIN * 60_000);
  const end = start + WINDOW_H * 3_600_000;
  const query = useGuide({ category, from: start, to: end });
  const channels = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const programmes = useMemo(() => Object.assign({}, ...(query.data?.pages.map((p) => p.programmes) ?? [])) as Record<string, Programme[]>, [query.data]);
  const [focused, setFocused] = useState<{ channel: Card; programme?: Programme } | null>(null);
  const [info, setInfo] = useState<{ channel: Card; programme: Programme } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const pxPerMin = window.innerWidth <= 820 ? 0.28 * rem : 0.38 * rem;
  const chanW = window.innerWidth <= 820 ? 8.5 * rem : 15 * rem;
  const rowH = 4.4 * rem;
  const timelineW = WINDOW_H * 60 * pxPerMin;
  const x = (ms: number) => ((Math.max(start, Math.min(end, ms)) - start) / 60_000) * pxPerMin;

  const hasMore = !!query.hasNextPage;
  const virt = useWindowVirtualizer({ count: channels.length + (hasMore ? 1 : 0), estimateSize: () => rowH, overscan: 6, scrollMargin: listRef.current?.offsetTop ?? 0 });
  const vItems = virt.getVirtualItems();
  useEffect(() => {
    const last = vItems[vItems.length - 1];
    if (last && last.index >= channels.length - 5 && hasMore && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [vItems, channels.length, hasMore, query]);

  useEffect(() => {
    if (channels.length) focusFirst(listRef.current ?? document);
  }, [category, !!channels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the "now" line in view when the window opens on the current time.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = Math.max(0, x(now) - 4 * rem);
  }, [start]); // eslint-disable-line react-hooks/exhaustive-deps

  const revealX = (el: HTMLElement) => {
    const s = scroller.current;
    if (!s) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < s.scrollLeft + 8) s.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
    else if (right > s.scrollLeft + s.clientWidth - chanW) s.scrollTo({ left: Math.min(right - s.clientWidth + chanW + 16, left - 16), behavior: 'smooth' });
  };

  const select = (channel: Card, p?: Programme) => {
    if (!p || (p.start <= Date.now() && p.stop > Date.now())) navigate(`/watch/${enc(channel.id)}`);
    else setInfo({ channel, programme: p });
  };

  const slots = Array.from({ length: (WINDOW_H * 60) / SLOT_MIN }, (_, i) => start + i * SLOT_MIN * 60_000);
  const preview = focused?.programme;

  return (
    <main className="page guide-page">
      <div className="guide-head">
        <div className="guide-preview">
          {focused ? (
            <>
              <span className="t-eyebrow">
                {focused.channel.number ? `${focused.channel.number} · ` : ''}
                {focused.channel.title}
                {preview && preview.start <= now && preview.stop > now && <span className="badge live" style={{ marginLeft: '0.6rem' }}>Live</span>}
              </span>
              <h1 className="t-headline clamp-2">{preview?.title ?? 'No guide information'}</h1>
              {preview && (
                <p className="t-caption tabular">
                  {timeLabel(preview.start)} – {timeLabel(preview.stop)}
                  {preview.category ? ` · ${preview.category}` : ''}
                </p>
              )}
              {preview?.desc && <p className="t-body clamp-2" style={{ maxWidth: '50rem' }}>{preview.desc}</p>}
            </>
          ) : (
            <>
              <span className="t-eyebrow">Programme guide</span>
              <h1 className="t-headline">What’s on</h1>
            </>
          )}
        </div>
        <div className="guide-controls">
          <select className="input select" value={category ?? ''} onChange={(e) => setParams({ category: e.target.value }, { replace: true })} aria-label="Category">
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.guideCount ? `${c.guideCount} with guide` : c.count})
              </option>
            ))}
          </select>
          <button className="glass-btn icon" onClick={() => setStart((s) => s - 2 * 3_600_000)} aria-label="Earlier" disabled={start < Date.now() - 5 * 3_600_000}>
            <IconChevronLeft />
          </button>
          <button className="glass-btn" onClick={() => setStart(floorToSlot(Date.now()) - SLOT_MIN * 60_000)}>
            Now
          </button>
          <button className="glass-btn icon" onClick={() => setStart((s) => s + 2 * 3_600_000)} aria-label="Later" disabled={start > Date.now() + 60 * 3_600_000}>
            <IconChevronRight />
          </button>
        </div>
      </div>

      {query.isError ? (
        <EmptyState icon="alert" title="The guide couldn’t load" body={(query.error as Error).message} actions={<button className="glass-btn primary" onClick={() => query.refetch()}>Retry</button>} />
      ) : !query.isLoading && !channels.length ? (
        <EmptyState title="No channels in this category" />
      ) : (
        <div className="guide glass" style={{ ['--chan-w' as string]: `${chanW}px`, ['--row-h' as string]: `${rowH}px` }}>
          <div className="guide-scroll no-scrollbar" ref={scroller}>
            <div style={{ width: chanW + timelineW, position: 'relative' }}>
              <div className="guide-ruler" style={{ paddingLeft: chanW }}>
                {slots.map((t) => (
                  <span key={t} className="tick tabular" style={{ width: SLOT_MIN * pxPerMin }}>
                    {timeLabel(t)}
                  </span>
                ))}
              </div>
              <div ref={listRef} style={{ position: 'relative', height: virt.getTotalSize() }}>
                {now >= start && now <= end && <div className="now-line" style={{ left: chanW + x(now) }} aria-hidden="true" />}
                {vItems.map((v) => {
                  const ch = channels[v.index];
                  if (!ch) return <div key={v.key} className="guide-row skeleton" style={{ position: 'absolute', top: v.start - virt.options.scrollMargin, height: rowH - 6, left: 0, right: 0 }} />;
                  const list = (programmes[ch.id] ?? []).filter((p) => p.stop > start && p.start < end);
                  return (
                    <div key={v.key} className="guide-row" style={{ position: 'absolute', top: v.start - virt.options.scrollMargin, height: rowH, left: 0, width: chanW + timelineW }} data-focus-zone={`g-${ch.id}`}>
                      <button className="guide-chan" onClick={() => select(ch)} onFocus={() => setFocused({ channel: ch, programme: list.find((p) => p.start <= now && p.stop > now) })} aria-label={`${ch.title}, play`}>
                        {ch.number !== undefined && <span className="num tabular">{ch.number}</span>}
                        <span className="logo">
                          <Img src={art(ch.logo)} alt="" fallback={<span className="t-caption">{ch.title.slice(0, 3)}</span>} />
                        </span>
                        <span className="name">{ch.title}</span>
                      </button>
                      <div className="guide-track" style={{ left: chanW, width: timelineW }}>
                        {list.length ? (
                          list.map((p) => {
                            const left = x(p.start);
                            const width = Math.max(4, x(p.stop) - left - 4);
                            const live = p.start <= now && p.stop > now;
                            const past = p.stop <= now;
                            return (
                              <button
                                key={p.start}
                                className={`prog ${live ? 'live' : ''} ${past ? 'past' : ''}`}
                                style={{ left, width }}
                                onFocus={(e) => {
                                  setFocused({ channel: ch, programme: p });
                                  revealX(e.currentTarget);
                                }}
                                onClick={() => select(ch, p)}
                                aria-label={`${p.title}, ${timeLabel(p.start)} to ${timeLabel(p.stop)}${live ? ', on now' : ''}`}
                              >
                                {live && <span className="prog-fill" style={{ width: `${((now - p.start) / (p.stop - p.start)) * 100}%` }} />}
                                <span className="prog-title">{p.title}</span>
                                {width > 90 && <span className="prog-time tabular">{timeLabel(p.start)}</span>}
                              </button>
                            );
                          })
                        ) : (
                          <button className="prog empty" style={{ left: 0, width: timelineW - 4 }} onFocus={() => setFocused({ channel: ch })} onClick={() => select(ch)}>
                            <span className="prog-title">{ch.title} · no guide data</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <Dialog open={!!info} onClose={() => setInfo(null)} title={info?.programme.title}>
        {info && (
          <>
            <p className="t-caption tabular">
              {info.channel.title} · {new Date(info.programme.start).toLocaleDateString([], { weekday: 'long' })} {timeLabel(info.programme.start)} – {timeLabel(info.programme.stop)}
            </p>
            {info.programme.desc && <p className="t-body" style={{ marginTop: '1rem' }}>{info.programme.desc}</p>}
            <div className="actions">
              <button className="glass-btn" onClick={() => setInfo(null)}>
                Close
              </button>
              <button className="glass-btn primary" onClick={() => navigate(`/watch/${enc(info.channel.id)}`)} data-autofocus>
                <IconPlay /> Watch {info.channel.title} live
              </button>
            </div>
          </>
        )}
      </Dialog>
    </main>
  );
}
