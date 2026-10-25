import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { formatClock, formatDuration, qualityFromHeight } from '@atlas/core';
import { enc, type Episode, type MovieDetail as MovieT, type SeriesDetail as SeriesT } from '../lib/api.ts';
import { useListToggle, useMovie, useSeries } from '../lib/queries.ts';
import { art, backdropSize } from '../lib/img.ts';
import { useUi } from '../lib/store.ts';
import { focusFirst } from '../lib/focus.ts';
import { Shelf } from '../components/Cards.tsx';
import { EmptyState, Img } from '../components/Primitives.tsx';
import { IconCheck, IconPlay, IconPlus, IconRefresh } from '../components/Icons.tsx';

function DetailBackdrop({ src, poster }: { src?: string; poster?: string }) {
  return (
    <motion.div className="detail-art" initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9, ease: [0.2, 0, 0, 1] }}>
      {src ? <img src={art(src, backdropSize())} alt="" referrerPolicy="no-referrer" /> : poster ? <img src={art(poster, 'w780')} alt="" className="poster-as-backdrop" referrerPolicy="no-referrer" /> : null}
    </motion.div>
  );
}

function Meta({ items }: { items: Array<string | number | undefined | false> }) {
  const list = items.filter(Boolean);
  return (
    <div className="hero-meta">
      {list.map((m, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span className="sep">•</span>}
          <span>{m}</span>
        </span>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <main className="detail">
      <div className="detail-content" style={{ gap: '1rem' }}>
        <div className="skeleton" style={{ width: '24rem', height: '4rem' }} />
        <div className="skeleton" style={{ width: '16rem', height: '1.4rem' }} />
        <div className="skeleton" style={{ width: '36rem', height: '5rem', maxWidth: '100%' }} />
      </div>
    </main>
  );
}

/** Quality badge only from what the player measured; provider claims are labelled as such. */
function QualityBadges({ verified, reportedHeight, hint }: { verified?: { width: number; height: number }; reportedHeight?: number; hint?: string }) {
  const v = qualityFromHeight(verified?.height, verified?.width);
  return (
    <>
      {v && (
        <span className="badge solid" title="Measured during playback on this device">
          {v}
        </span>
      )}
      {!v && (reportedHeight || hint) && (
        <span className="badge" title="Reported by your provider, not yet verified">
          {qualityFromHeight(reportedHeight) ?? hint} · provider
        </span>
      )}
    </>
  );
}

export function MovieDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useMovie(id);
  const toggle = useListToggle(id, 'movie');
  const setAmbient = useUi((s) => s.setAmbient);

  useEffect(() => {
    if (data) {
      setAmbient(data.backdrop ?? data.poster);
      if (params.get('play') === '1') navigate(`/watch/${enc(id)}`, { replace: true });
      else focusFirst(document.querySelector('main') ?? document);
    }
  }, [data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <DetailSkeleton />;
  if (error || !data)
    return (
      <main className="page">
        <EmptyState icon="alert" title="This title isn’t available" body={(error as Error)?.message} actions={<button className="glass-btn primary" onClick={() => refetch()}>Retry</button>} />
      </main>
    );
  return <MovieView m={data} onToggle={() => toggle.mutate(!data.inList)} />;
}

function MovieView({ m, onToggle }: { m: MovieT; onToggle: () => void }) {
  const navigate = useNavigate();
  const resume = m.progress && !m.progress.finished && m.progress.position > 30 ? m.progress : undefined;
  const play = (fromStart = false) => navigate(`/watch/${enc(m.id)}${fromStart ? '?start=0' : ''}`);
  return (
    <main className="detail">
      <DetailBackdrop src={m.backdrop} poster={m.poster} />
      <motion.div className="detail-content" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 28, delay: 0.1 }}>
        <span className="t-eyebrow">{m.category ?? 'Movie'}</span>
        <h1 className="t-display">{m.title}</h1>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Meta items={[m.year, m.genres?.slice(0, 3).join(' · '), m.runtimeMin && formatDuration(m.runtimeMin * 60)]} />
          {m.rating !== undefined && (
            <span className="badge" title="Rating supplied by your provider">
              ★ {m.rating.toFixed(1)}
            </span>
          )}
          <QualityBadges verified={m.verified} reportedHeight={m.reported?.video?.height} hint={m.qualityHint} />
          {m.reported?.audio?.channels && m.reported.audio.channels > 2 && <span className="badge">{m.reported.audio.channels === 6 ? '5.1' : `${m.reported.audio.channels}ch`}</span>}
        </div>
        {m.plot && <p className="hero-plot">{m.plot}</p>}
        {resume && (
          <div className="resume-line">
            <span className="progress" style={{ maxWidth: '14rem' }}>
              <span style={{ width: `${(resume.position / resume.duration) * 100}%` }} />
            </span>
            <span className="t-caption tabular">{formatDuration(resume.duration - resume.position)} left</span>
          </div>
        )}
        <div className="hero-actions">
          <button className="glass-btn primary lg" onClick={() => play(false)} data-autofocus>
            <IconPlay /> {resume ? `Resume ${formatClock(resume.position)}` : 'Play'}
          </button>
          {resume && (
            <button className="glass-btn lg" onClick={() => play(true)}>
              <IconRefresh /> From the beginning
            </button>
          )}
          <button className="glass-btn lg" onClick={onToggle} aria-pressed={m.inList}>
            {m.inList ? <IconCheck /> : <IconPlus />} {m.inList ? 'In My List' : 'My List'}
          </button>
        </div>
        <dl className="credits">
          {m.cast && (
            <>
              <dt>Cast</dt>
              <dd className="clamp-2">{m.cast}</dd>
            </>
          )}
          {m.director && (
            <>
              <dt>Director</dt>
              <dd>{m.director}</dd>
            </>
          )}
          {m.reported?.audio?.language && (
            <>
              <dt>Audio</dt>
              <dd>
                {m.reported.audio.language.toUpperCase()}
                {m.reported.audio.codec ? ` · ${m.reported.audio.codec.toUpperCase()}` : ''}
              </dd>
            </>
          )}
          <dt>Source</dt>
          <dd>Metadata from your provider{m.container ? ` · ${m.container.toUpperCase()} file` : ''}</dd>
        </dl>
      </motion.div>
      {m.related.length > 0 && (
        <div className="detail-rows">
          <Shelf row={{ id: 'related', title: 'More Like This', layout: 'poster', items: m.related }} />
        </div>
      )}
    </main>
  );
}

export function SeriesDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useSeries(id);
  const toggle = useListToggle(id, 'series');
  const setAmbient = useUi((s) => s.setAmbient);

  useEffect(() => {
    if (data) {
      setAmbient(data.backdrop ?? data.poster);
      if (params.get('play') === '1' && data.nextEpisodeId) navigate(`/watch/${enc(data.nextEpisodeId)}`, { replace: true });
      else focusFirst(document.querySelector('main') ?? document);
    }
  }, [data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <DetailSkeleton />;
  if (error || !data)
    return (
      <main className="page">
        <EmptyState icon="alert" title="This series isn’t available" body={(error as Error)?.message} actions={<button className="glass-btn primary" onClick={() => refetch()}>Retry</button>} />
      </main>
    );
  return <SeriesView s={data} onToggle={() => toggle.mutate(!data.inList)} />;
}

function SeriesView({ s, onToggle }: { s: SeriesT; onToggle: () => void }) {
  const navigate = useNavigate();
  const nextEp = s.episodes.find((e) => e.id === s.nextEpisodeId);
  const [season, setSeason] = useState<number>(nextEp?.season ?? s.seasons[0]?.number ?? 1);
  const episodes = useMemo(() => s.episodes.filter((e) => e.season === season), [s.episodes, season]);
  const nextProg = nextEp ? s.episodeProgress[nextEp.id] : undefined;
  const started = !!Object.keys(s.episodeProgress).length;

  return (
    <main className="detail">
      <DetailBackdrop src={s.backdrop} poster={s.poster} />
      <motion.div className="detail-content" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 28, delay: 0.1 }}>
        <span className="t-eyebrow">{s.category ?? 'Series'}</span>
        <h1 className="t-display">{s.title}</h1>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Meta items={[s.year, s.genres?.slice(0, 3).join(' · '), s.seasons.length ? `${s.seasons.length} season${s.seasons.length > 1 ? 's' : ''}` : undefined]} />
          {s.rating !== undefined && (
            <span className="badge" title="Rating supplied by your provider">
              ★ {s.rating.toFixed(1)}
            </span>
          )}
        </div>
        {s.plot && <p className="hero-plot clamp-3">{s.plot}</p>}
        <div className="hero-actions">
          {nextEp ? (
            <button className="glass-btn primary lg" onClick={() => navigate(`/watch/${enc(nextEp.id)}`)} data-autofocus>
              <IconPlay /> {started ? (nextProg && !nextProg.finished ? 'Resume' : 'Play') : 'Play'} S{nextEp.season} · E{nextEp.episode}
            </button>
          ) : (
            <button className="glass-btn primary lg" disabled>
              No episodes available
            </button>
          )}
          <button className="glass-btn lg" onClick={onToggle} aria-pressed={s.inList}>
            {s.inList ? <IconCheck /> : <IconPlus />} {s.inList ? 'In My List' : 'My List'}
          </button>
        </div>
        {s.cast && (
          <dl className="credits">
            <dt>Cast</dt>
            <dd className="clamp-2">{s.cast}</dd>
          </dl>
        )}
      </motion.div>

      {s.seasons.length > 0 && (
        <section className="episodes" aria-label="Episodes">
          <div className="season-bar no-scrollbar" role="tablist" aria-label="Seasons" data-shelf data-focus-zone="seasons">
            {s.seasons.map((x) => (
              <button key={x.number} role="tab" className="chip" aria-selected={x.number === season} onClick={() => setSeason(x.number)} onFocus={() => setSeason(x.number)}>
                {x.name}
                <span className="count">{x.episodeCount}</span>
              </button>
            ))}
          </div>
          <div className="shelf no-scrollbar" data-shelf data-focus-zone={`ep-${season}`} role="list">
            {episodes.map((e) => (
              <EpisodeCard key={e.id} e={e} progress={s.episodeProgress[e.id]} fallbackArt={s.backdrop ?? s.poster} isNext={e.id === s.nextEpisodeId} />
            ))}
          </div>
        </section>
      )}
      {s.related.length > 0 && (
        <div className="detail-rows">
          <Shelf row={{ id: 'related', title: 'More Like This', layout: 'poster', items: s.related }} />
        </div>
      )}
    </main>
  );
}

/** AtlasEpisodeCard */
function EpisodeCard({ e, progress, fallbackArt, isNext }: { e: Episode; progress?: { position: number; duration: number; finished: boolean }; fallbackArt?: string; isNext: boolean }) {
  const navigate = useNavigate();
  const pct = progress ? (progress.finished ? 100 : (progress.position / progress.duration) * 100) : 0;
  return (
    <button className="card episode" data-focusable onClick={() => navigate(`/watch/${enc(e.id)}`)} aria-label={`Episode ${e.episode}: ${e.title}${progress?.finished ? ', watched' : ''}`} role="listitem">
      <div className="card-media">
        <Img src={art(e.thumb ?? fallbackArt, 'w500')} alt="" fallback={<div className="card-fallback">E{e.episode}</div>} />
        <span className="ep-play">
          <IconPlay />
        </span>
        {progress?.finished && (
          <span className="ep-watched" title="Watched">
            <IconCheck />
          </span>
        )}
        {pct > 0 && !progress?.finished && (
          <span className="ep-progress">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
      <div className="ep-text">
        <div className="ep-title">
          <span className="ep-num">{e.episode}</span>
          <span className="clamp-2">{e.title}</span>
          {isNext && <span className="badge solid" style={{ marginLeft: 'auto' }}>Up next</span>}
        </div>
        <div className="t-caption">{[e.runtimeSec && formatDuration(e.runtimeSec), e.airDate].filter(Boolean).join(' · ')}</div>
        {e.plot && <p className="ep-plot clamp-2">{e.plot}</p>}
      </div>
    </button>
  );
}
