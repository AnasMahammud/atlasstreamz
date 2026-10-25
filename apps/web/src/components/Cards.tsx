import { memo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatDuration } from '@atlas/core';
import type { Card, Row } from '../lib/api.ts';
import { art } from '../lib/img.ts';
import { useUi } from '../lib/store.ts';
import { Img, useNow } from './Primitives.tsx';
import { IconChevronRight, IconPlay } from './Icons.tsx';

export function hrefFor(c: Card): string {
  if (c.kind === 'movie') return `/movie/${encodeURIComponent(c.id)}`;
  if (c.kind === 'series') return `/series/${encodeURIComponent(c.id)}`;
  if (c.kind === 'episode') return `/watch/${encodeURIComponent(c.id)}`;
  return `/watch/${encodeURIComponent(c.id)}`;
}

function ambientOf(c: Card): string | undefined {
  return c.backdrop ?? c.poster;
}

const Fallback = ({ title }: { title: string }) => <div className="card-fallback">{title}</div>;

/** AtlasPosterCard — 2:3 artwork, caption below, "new" dot like the reference. */
export const PosterCard = memo(function PosterCard({ card, caption = true }: { card: Card; caption?: boolean }) {
  const setAmbient = useUi((s) => s.setAmbient);
  const pct = card.progress ? Math.min(100, (card.progress.position / card.progress.duration) * 100) : 0;
  return (
    <Link to={hrefFor(card)} className="card poster" data-focusable onFocus={() => setAmbient(ambientOf(card))} aria-label={`${card.title}${card.year ? `, ${card.year}` : ''}`}>
      <div className="card-media">
        <Img src={art(card.poster, 'w342')} alt="" fallback={<Fallback title={card.title} />} />
        {card.isNew && <span className="new-dot" title="Recently added" />}
        {pct > 0 && (
          <div style={{ position: 'absolute', left: '0.6rem', right: '0.6rem', bottom: '0.6rem', zIndex: 3, display: 'flex' }}>
            <div className="progress" style={{ maxWidth: 'none' }}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </div>
      {caption && (
        <div className="card-caption">
          <span className="title">{card.title}</span>
          <span className="sub">{card.reason ?? [card.year, card.category].filter(Boolean).join(' · ')}</span>
        </div>
      )}
    </Link>
  );
});

/** AtlasLandscapeCard — 16:9 art with title, play glyph and progress inside the frame. */
export const LandscapeCard = memo(function LandscapeCard({ card }: { card: Card }) {
  const setAmbient = useUi((s) => s.setAmbient);
  const p = card.progress;
  const pct = p ? Math.min(100, (p.position / p.duration) * 100) : 0;
  const left = p ? formatDuration(Math.max(0, p.duration - p.position)) : undefined;
  const to = card.kind === 'episode' || p ? `/watch/${encodeURIComponent(card.id)}` : hrefFor(card);
  return (
    <Link to={to} className="card landscape" data-focusable onFocus={() => setAmbient(ambientOf(card))} aria-label={`${card.title}${card.subtitle ? `, ${card.subtitle}` : ''}${left ? `, ${left} left` : ''}`}>
      <div className="card-media">
        <Img src={art(card.backdrop ?? card.poster, 'w780')} alt="" fallback={<Fallback title={card.title} />} />
        {card.isNew && <span className="new-dot" />}
        <div className="overlay">
          <span className="title clamp-2">{card.title}</span>
          <span className="meta">
            <IconPlay />
            {p ? (
              <>
                <span className="progress">
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="tabular">{left}</span>
              </>
            ) : (
              <span>{card.subtitle ?? [card.year, card.category].filter(Boolean).join(' · ')}</span>
            )}
          </span>
          {p && card.subtitle && <span className="t-caption" style={{ color: 'rgba(244,246,248,.7)' }}>{card.subtitle}</span>}
        </div>
      </div>
    </Link>
  );
});

function initials(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** AtlasChannelTile — logo on frosted panel, now playing, live progress. */
export const ChannelTile = memo(function ChannelTile({ card, onSelect }: { card: Card; onSelect?: (c: Card) => void }) {
  const now = useNow(30_000);
  const setAmbient = useUi((s) => s.setAmbient);
  const navigate = useNavigate();
  const prog = card.now ? Math.min(100, Math.max(0, ((now - card.now.start) / (card.now.stop - card.now.start)) * 100)) : 0;
  return (
    <button
      className="card channel"
      data-focusable
      onFocus={() => setAmbient(undefined)}
      onClick={() => (onSelect ? onSelect(card) : navigate(`/watch/${encodeURIComponent(card.id)}`))}
      aria-label={`${card.title}${card.now ? `, now: ${card.now.title}` : ''}`}
    >
      <div className="card-media">
        <div className="logo">
          <Img src={art(card.logo)} alt="" fallback={<span className="initials">{initials(card.title)}</span>} />
        </div>
        <div className="info">
          <span className="row1">
            {card.number !== undefined && <span className="num">{card.number}</span>}
            <span className="name">{card.title}</span>
          </span>
          <span className="now">{card.now ? card.now.title : card.next ? `Next: ${card.next.title}` : card.category ?? 'Live'}</span>
          {card.now && (
            <span className="progress">
              <span style={{ width: `${prog}%` }} />
            </span>
          )}
        </div>
      </div>
    </button>
  );
});

export function ContentCard({ card, layout }: { card: Card; layout: Row['layout'] }) {
  if (card.kind === 'live') return <ChannelTile card={card} />;
  if (layout === 'landscape' || layout === 'continue') return <LandscapeCard card={card} />;
  return <PosterCard card={card} />;
}

/** AtlasRow: titled horizontal shelf. Remembers focus per shelf for remote navigation. */
export function Shelf({ row, extra }: { row: Row; extra?: ReactNode }) {
  return (
    <section aria-label={row.title}>
      <div className="row-head">
        <h2 className="t-section">{row.title}</h2>
        {row.note && <span className="note">{row.note}</span>}
        {extra}
        {row.href && (
          <Link to={row.href} className="see-all" data-focusable aria-label={`See all ${row.title}`}>
            See all <IconChevronRight style={{ width: '0.9em', height: '0.9em', display: 'inline', verticalAlign: '-0.1em' }} />
          </Link>
        )}
      </div>
      <div className="shelf no-scrollbar" data-shelf data-focus-zone={row.id} role="list">
        {row.items.map((c) => (
          <div role="listitem" key={c.id} style={{ display: 'contents' }}>
            <ContentCard card={c} layout={row.layout} />
          </div>
        ))}
      </div>
    </section>
  );
}
