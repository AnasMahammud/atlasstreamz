import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { HeroItem } from '../lib/api.ts';
import { api, enc } from '../lib/api.ts';
import { art, backdropSize } from '../lib/img.ts';
import { prefersReducedMotion } from '../lib/device.ts';
import { toast, useUi } from '../lib/store.ts';
import { IconInfo, IconPlay, IconPlus } from './Icons.tsx';

const INTERVAL = 9000;

/**
 * AtlasHeroCarousel. Cross-fades between featured titles with a slow push-in. Auto-advance
 * pauses while the hero has focus/hover, and is off entirely with reduced motion.
 * No trailers auto-play: artwork only.
 */
export function Hero({ items }: { items: HeroItem[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [cycle, setCycle] = useState(0);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setAmbient = useUi((s) => s.setAmbient);
  const ref = useRef<HTMLElement>(null);
  const reduced = prefersReducedMotion();
  const item = items[index % Math.max(1, items.length)];

  useEffect(() => {
    if (item) setAmbient(item.backdrop);
  }, [item, setAmbient]);

  useEffect(() => {
    if (paused || reduced || items.length < 2) return;
    const t = window.setTimeout(() => {
      setIndex((i) => (i + 1) % items.length);
      setCycle((c) => c + 1);
    }, INTERVAL);
    return () => window.clearTimeout(t);
  }, [index, paused, reduced, items.length, cycle]);

  // Preload the next backdrop so the cross-fade never shows a blank frame.
  useEffect(() => {
    const next = items[(index + 1) % items.length];
    if (next) {
      const img = new Image();
      img.src = art(next.backdrop, backdropSize())!;
    }
  }, [index, items]);

  const go = useCallback(
    (i: number) => {
      setIndex(i);
      setCycle((c) => c + 1);
    },
    [],
  );

  if (!item) return null;
  const href = `/${item.kind === 'movie' ? 'movie' : 'series'}/${enc(item.id)}`;
  const meta = [item.year, item.genres?.slice(0, 2).join(' · ') ?? item.category, item.runtimeMin ? `${Math.floor(item.runtimeMin / 60)}h ${item.runtimeMin % 60}m` : undefined].filter(Boolean);

  const addToList = async () => {
    try {
      await api.put(`/api/me/list/${enc(item.id)}`);
      toast(`Added ${item.title} to My List`, { tone: 'success' });
      void qc.invalidateQueries({ queryKey: ['home'] });
      void qc.invalidateQueries({ queryKey: ['my-list'] });
    } catch {
      toast('Couldn’t update My List', { tone: 'error' });
    }
  };

  return (
    <section
      ref={ref}
      className="hero"
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node)) setPaused(false);
      }}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={item.id}
          className="hero-art"
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ opacity: { duration: 1.1, ease: [0.2, 0, 0, 1] }, scale: { duration: reduced ? 0 : 9, ease: 'linear' } }}
        >
          <img src={art(item.backdrop, backdropSize())} alt="" referrerPolicy="no-referrer" />
        </motion.div>
      </AnimatePresence>

      <div className="hero-content" data-reveal-top>
        <AnimatePresence mode="wait">
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 220, damping: 30 }}
            style={{ display: 'grid', gap: '1.05rem' }}
          >
            <span className="t-eyebrow">{item.kind === 'movie' ? 'Featured Movie' : 'Featured Series'}</span>
            <h1 className="t-display">{item.title}</h1>
            <div className="hero-meta">
              {meta.map((m, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  {i > 0 && <span className="sep">•</span>}
                  <span>{m}</span>
                </span>
              ))}
              {item.rating !== undefined && (
                <span className="badge" title="Rating supplied by your provider">
                  ★ {item.rating.toFixed(1)}
                </span>
              )}
            </div>
            {item.plot && <p className="hero-plot clamp-3">{item.plot}</p>}
          </motion.div>
        </AnimatePresence>
        <div className="hero-actions">
          <button className="glass-btn primary lg" data-autofocus onClick={() => navigate(href + '?play=1')}>
            <IconPlay /> Watch Now
          </button>
          <button className="glass-btn lg" onClick={() => navigate(href)}>
            <IconInfo /> More Info
          </button>
          <button className="glass-btn icon lg" style={{ width: '3.25rem' }} onClick={addToList} aria-label={`Add ${item.title} to My List`}>
            <IconPlus />
          </button>
        </div>
      </div>

      {items.length > 1 && (
        <div className="hero-dots" role="tablist" aria-label="Featured titles">
          {items.map((h, i) => (
            <button key={h.id} role="tab" aria-selected={i === index} aria-current={i === index} aria-label={h.title} className="hero-dot" onClick={() => go(i)} data-focus-skip>
              {i === index && !reduced && !paused && (
                <motion.span key={cycle} className="fill" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: INTERVAL / 1000, ease: 'linear' }} />
              )}
              {i === index && (reduced || paused) && <span className="fill" />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
