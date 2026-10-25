import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backoffDelay, formatClock, qualityFromHeight } from '@atlas/core';
import { api, ApiError, enc, type Card, type PlayInfo } from '../lib/api.ts';
import { attachEngine, type EngineHandle, type FatalKind, type Level, type Track } from '../lib/playback.ts';
import { shiftTrack, toVtt } from '../lib/subtitles.ts';
import { art } from '../lib/img.ts';
import { focusFirst, pushBack } from '../lib/focus.ts';
import { toast, useUi } from '../lib/store.ts';
import { useBrowse, useChannel, useStatus } from '../lib/queries.ts';
import { Img, timeLabel, useNow } from '../components/Primitives.tsx';
import {
  IconAudio,
  IconAspect,
  IconBack10,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronUp,
  IconExitFullscreen,
  IconForward10,
  IconFullscreen,
  IconGuide,
  IconMute,
  IconNext,
  IconPause,
  IconPip,
  IconPlay,
  IconSettings,
  IconStar,
  IconSubtitles,
  IconUpload,
  IconVolume,
} from '../components/Icons.tsx';

type Menu = null | 'audio' | 'subtitles' | 'settings' | 'guide';
type Failure = { kind: FatalKind | 'offline' | 'provider' | 'expired'; title: string; body: string };

const HIDE_MS = 3500;

/**
 * AtlasMediaPlayer.
 *
 * Recovery order on a fatal error: retry the same engine with backoff (network), recover in
 * place (decode), then the next engine the server offered (e.g. HLS → MPEG-TS), then ask the
 * server whether the provider/account is the problem. Alternate feeds for a live channel are
 * only offered to the user, with their category shown — never switched silently.
 */
interface AtlasNativeBridge {
  play: (json: string) => void;
  changeServer: () => void;
  info: () => string;
}

export function atlasNative(): AtlasNativeBridge | undefined {
  return (window as unknown as { AtlasNative?: AtlasNativeBridge }).AtlasNative;
}

/** Inside the Android app, playback is native (Media3/ExoPlayer); in browsers it's the web player. */
export default function Player() {
  return atlasNative() ? <NativeHandoff /> : <WebPlayer />;
}

function NativeHandoff() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get<PlayInfo>(`/api/play/${enc(id)}`)
      .then((info) => {
        if (cancelled) return;
        atlasNative()!.play(JSON.stringify({ ...info, resumeAt: search.get('start') === '0' ? 0 : info.resumeAt }));
        // Leave the /watch route so Back from the native player returns to where you were.
        if (history.length > 1) navigate(-1);
        else navigate('/', { replace: true });
      })
      .catch((e) => !cancelled && setError(e as ApiError));
    return () => {
      cancelled = true;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!error) {
    return (
      <div className="player">
        <div className="player-buffer">
          <div className="spinner" />
        </div>
      </div>
    );
  }
  return (
    <div className="player">
      <PlayerError
        title={error.data?.code === 'consent' ? 'Connection not allowed yet' : 'Can’t play this'}
        body={error.message}
        onBack={() => navigate(-1)}
        onSettings={error.data?.code === 'consent' ? () => navigate('/settings/sources') : undefined}
      />
    </div>
  );
}

function WebPlayer() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: status } = useStatus();
  const subtitleStyle = useUi((s) => s.subtitleStyle);
  const setSubtitleStyle = useUi((s) => s.setSubtitleStyle);
  const device = useUi((s) => s.device);
  const prefs = status?.profile?.prefs;

  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const sourceIdx = useRef(0);
  const attempt = useRef(0);
  const retryTimer = useRef<number>();
  const hideTimer = useRef<number>();
  const reportedQuality = useRef(false);
  const lastSaved = useRef(0);

  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [visible, setVisible] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fit, setFit] = useState<'contain' | 'cover' | 'fill'>('contain');
  const [speed, setSpeed] = useState(1);
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1);
  const [audio, setAudio] = useState<Track[]>([]);
  const [audioSel, setAudioSel] = useState(-1);
  const [subs, setSubs] = useState<Track[]>([]);
  const [subSel, setSubSel] = useState(-1);
  const [subOffset, setSubOffset] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [engineLabel, setEngineLabel] = useState('');
  const [upNext, setUpNext] = useState<{ card: Card; seconds: number } | null>(null);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [banner, setBanner] = useState(true);

  const live = info?.kind === 'live';
  const { data: channel } = useChannel(live ? id : undefined);

  /* ---------------- load play info ---------------- */
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setFailure(null);
    setLoadError(null);
    setUpNext(null);
    setUpNextDismissed(false);
    setBanner(true);
    reportedQuality.current = false;
    sourceIdx.current = 0;
    attempt.current = 0;
    api
      .get<PlayInfo>(`/api/play/${enc(id)}`)
      .then((d) => !cancelled && setInfo(d))
      .catch((e) => !cancelled && setLoadError(e as ApiError));
    return () => {
      cancelled = true;
    };
  }, [id]);

  /* ---------------- engine lifecycle ---------------- */
  const saveProgress = useCallback(
    (force = false) => {
      const v = videoRef.current;
      if (!v || !info) return;
      const now = Date.now();
      if (!force && now - lastSaved.current < 10_000) return;
      lastSaved.current = now;
      if (info.kind === 'live') {
        void fetch(`/api/me/progress/${enc(info.id)}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: 0, duration: 1 }) }).catch(() => {});
        return;
      }
      if (!v.duration || !isFinite(v.duration) || v.currentTime < 5) return;
      void fetch(`/api/me/progress/${enc(info.id)}`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: v.currentTime, duration: v.duration }),
      }).catch(() => {});
    },
    [info],
  );

  const refreshTracks = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    setLevels(e.levels());
    setLevel(e.currentLevel());
    setAudio(e.audioTracks());
    setAudioSel(e.currentAudio());
    setSubs(e.subtitleTracks());
    setSubSel(e.currentSubtitle());
  }, []);

  const start = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !info) return;
    engineRef.current?.destroy();
    engineRef.current = null;
    const source = info.sources[sourceIdx.current];
    if (!source) return;
    setFailure(null);
    setBuffering(true);
    setEngineLabel(source.label);
    const resumeAt = search.get('start') === '0' ? 0 : info.resumeAt;
    try {
      const handle = await attachEngine(v, source, {
        live: info.kind === 'live',
        startAt: resumeAt,
        lowMemory: device === 'tv',
        events: {
          onFatal: (kind, detail) => onFatalRef.current(kind, detail),
          onTracksChanged: refreshTracks,
        },
      });
      engineRef.current = handle;
      if (prefs?.dataSaver) handle.capQuality(720);
      if (source.engine === 'native' && resumeAt > 0) {
        v.addEventListener('loadedmetadata', () => (v.currentTime = resumeAt), { once: true });
      }
      if (resumeAt > 0 && attempt.current === 0 && sourceIdx.current === 0) {
        toast(`Resuming from ${formatClock(resumeAt)}`, {
          action: {
            label: 'Start over',
            run: () => {
              if (videoRef.current) videoRef.current.currentTime = 0;
            },
          },
        });
      }
      await v.play().catch(() => {
        /* autoplay with sound may be blocked until a gesture; controls stay visible */
      });
    } catch {
      /* onFatal already reported */
    }
  }, [info, search, device, prefs?.dataSaver, refreshTracks]);

  const nextSource = useCallback(() => {
    if (!info) return false;
    if (sourceIdx.current + 1 < info.sources.length) {
      sourceIdx.current++;
      attempt.current = 0;
      toast(`Trying ${info.sources[sourceIdx.current].label} playback…`);
      void start();
      return true;
    }
    return false;
  }, [info, start]);

  const giveUp = useCallback(
    async (kind: FatalKind, detail: string) => {
      if (!navigator.onLine) {
        setFailure({ kind: 'offline', title: 'No internet connection', body: 'Playback needs a connection. ATLAS will retry as soon as you’re back online.' });
        return;
      }
      if (kind === 'unsupported') {
        setFailure({ kind, title: 'This format isn’t supported here', body: `${detail} Try another device, or ask your provider for an MP4/HLS version.` });
        return;
      }
      let diag: { provider: string; maxConnections?: number; activeConnections?: number } | null = null;
      try {
        diag = await api.get(`/api/play/${enc(id)}/diagnose`);
      } catch {
        /* server unreachable */
      }
      if (diag?.provider === 'rejected') {
        setFailure({ kind: 'expired', title: 'Your provider rejected the connection', body: 'The account may have expired or its credentials changed. Check the source in Settings.' });
      } else if (diag?.provider === 'unreachable') {
        setFailure({ kind: 'provider', title: 'The provider isn’t responding', body: 'It may be down for maintenance. Try again in a few minutes.' });
      } else if (diag?.maxConnections && diag.activeConnections !== undefined && diag.activeConnections >= diag.maxConnections) {
        setFailure({ kind: 'provider', title: 'Too many streams at once', body: `Your provider allows ${diag.maxConnections} streams at a time and they’re all in use. Stop playback on another device and retry.` });
      } else {
        setFailure({ kind, title: live ? 'This channel isn’t available right now' : 'This title couldn’t be played', body: live ? 'The broadcast may be off air or the feed is down.' : `The stream stopped responding (${detail}).` });
      }
    },
    [id, live],
  );

  const onFatal = useCallback(
    (kind: FatalKind, detail: string) => {
      const e = engineRef.current;
      window.clearTimeout(retryTimer.current);
      if (kind === 'auth') return void giveUp(kind, detail);
      if (kind === 'network' && e && attempt.current < 3) {
        const wait = backoffDelay(attempt.current, 1000, 8000);
        attempt.current++;
        setBuffering(true);
        retryTimer.current = window.setTimeout(() => {
          if (!navigator.onLine) return void giveUp('network', detail);
          if (!e.retry()) void start();
        }, wait);
        return;
      }
      if (kind === 'media' && e?.recoverMedia()) return;
      if (nextSource()) return;
      void giveUp(kind, detail);
    },
    [giveUp, nextSource, start],
  );
  const onFatalRef = useRef(onFatal);
  onFatalRef.current = onFatal;

  useEffect(() => {
    if (!info) return;
    void start();
    return () => {
      window.clearTimeout(retryTimer.current);
      saveProgress(true);
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back online → retry automatically.
  useEffect(() => {
    const onOnline = () => {
      if (failure?.kind === 'offline') {
        attempt.current = 0;
        void start();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [failure, start]);

  /* ---------------- video element events ---------------- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let stallTimer: number | undefined;
    const onTime = () => {
      setTime(v.currentTime);
      if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
      saveProgress();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      saveProgress(true);
    };
    const onWaiting = () => {
      setBuffering(true);
      window.clearTimeout(stallTimer);
      // A live stream stuck buffering for 15 s is treated as a network failure.
      stallTimer = window.setTimeout(() => {
        if (v.readyState < 3) onFatalRef.current('network', 'stalled');
      }, 15_000);
    };
    const onPlaying = () => {
      setBuffering(false);
      window.clearTimeout(stallTimer);
      attempt.current = 0;
    };
    const onDuration = () => setDuration(isFinite(v.duration) ? v.duration : 0);
    const onResize = () => {
      if (!v.videoHeight) return;
      setSize({ w: v.videoWidth, h: v.videoHeight });
      if (!reportedQuality.current && info) {
        reportedQuality.current = true;
        void api.post(`/api/me/quality/${enc(info.id)}`, { width: v.videoWidth, height: v.videoHeight }).catch(() => {});
      }
    };
    const onVolume = () => setMuted(v.muted);
    const onEnded = () => {
      saveProgress(true);
      if (info?.nextEpisode && info.autoplayNext && !upNextDismissed) setUpNext({ card: info.nextEpisode, seconds: 0 });
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onPlaying);
    v.addEventListener('durationchange', onDuration);
    v.addEventListener('resize', onResize);
    v.addEventListener('loadedmetadata', onResize);
    v.addEventListener('volumechange', onVolume);
    v.addEventListener('ended', onEnded);
    return () => {
      window.clearTimeout(stallTimer);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onPlaying);
      v.removeEventListener('durationchange', onDuration);
      v.removeEventListener('resize', onResize);
      v.removeEventListener('loadedmetadata', onResize);
      v.removeEventListener('volumechange', onVolume);
      v.removeEventListener('ended', onEnded);
    };
  }, [info, saveProgress, upNextDismissed]);

  // Up next: appears in the last 30 s of an episode with a 10 s countdown.
  useEffect(() => {
    if (!info?.nextEpisode || live || upNextDismissed || !duration) return;
    const remaining = duration - time;
    if (remaining < 30 && remaining > 0 && !upNext) setUpNext({ card: info.nextEpisode, seconds: info.autoplayNext ? 10 : -1 });
  }, [time, duration, info, live, upNext, upNextDismissed]);
  useEffect(() => {
    if (!upNext || upNext.seconds < 0) return;
    if (upNext.seconds === 0) {
      navigate(`/watch/${enc(upNext.card.id)}`, { replace: true });
      return;
    }
    const t = window.setTimeout(() => setUpNext((u) => (u ? { ...u, seconds: u.seconds - 1 } : u)), 1000);
    return () => window.clearTimeout(t);
  }, [upNext, navigate]);

  // Channel banner fades after a few seconds on live.
  useEffect(() => {
    if (!live) return;
    const t = window.setTimeout(() => setBanner(false), 5000);
    return () => window.clearTimeout(t);
  }, [live, id]);

  /* ---------------- controls visibility ---------------- */
  const poke = useCallback(() => {
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!videoRef.current?.paused && !menu) setVisible(false);
    }, HIDE_MS);
  }, [menu]);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, [playing, menu, poke]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  /* ---------------- actions ---------------- */
  const exit = useCallback(() => {
    saveProgress(true);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    if (info?.kind === 'episode' && info.seriesId) navigate(`/series/${enc(info.seriesId)}`, { replace: true });
    else if (history.length > 1) navigate(-1);
    else navigate('/', { replace: true });
  }, [info, navigate, saveProgress]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const seek = (delta: number) => {
    const v = videoRef.current;
    if (!v || live) return;
    v.currentTime = Math.max(0, Math.min((v.duration || 0) - 1, v.currentTime + delta));
    poke();
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => {});
  };
  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      toast('Picture-in-Picture isn’t available here.');
    }
  };
  const switchChannel = (target?: string) => {
    if (!target) return;
    navigate(`/watch/${enc(target)}`, { replace: true });
  };
  const toggleFavourite = async () => {
    if (!channel) return;
    if (channel.inList) await api.del(`/api/me/list/${enc(id)}`);
    else await api.put(`/api/me/list/${enc(id)}`);
    void qc.invalidateQueries({ queryKey: ['channel', id] });
    void qc.invalidateQueries({ queryKey: ['live-home'] });
    toast(channel.inList ? 'Removed from Favourites' : 'Added to Favourites', { tone: 'success' });
  };

  const chooseSub = (sel: number) => {
    engineRef.current?.setSubtitle(sel);
    setSubSel(sel);
  };

  const importSubtitle = async (file: File) => {
    const v = videoRef.current;
    if (!v) return;
    try {
      const vtt = toVtt(file.name, await file.text());
      const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = file.name.replace(/\.(srt|vtt)$/i, '');
      track.srclang = prefs?.subtitleLang ?? 'und';
      track.src = url;
      track.default = true;
      v.appendChild(track);
      track.addEventListener('load', () => {
        const idx = Array.from(v.textTracks).indexOf(track.track);
        Array.from(v.textTracks).forEach((t, i) => (t.mode = i === idx ? 'showing' : 'disabled'));
        setSubs((s) => [...s.filter((x) => x.id !== idx), { id: idx, label: track.label }]);
        setSubSel(idx);
        setSubOffset(0);
        toast(`Subtitles loaded: ${track.label}`, { tone: 'success' });
      });
    } catch (err) {
      toast((err as Error).message, { tone: 'error' });
    }
  };

  const adjustOffset = (delta: number) => {
    const v = videoRef.current;
    if (!v || subSel < 0) return;
    const t = v.textTracks[subSel];
    if (t) shiftTrack(t, delta);
    setSubOffset((o) => Math.round((o + delta) * 10) / 10);
  };

  /* ---------------- keyboard & remote ---------------- */
  useEffect(
    () =>
      pushBack(() => {
        if (menu) {
          setMenu(null);
          return true;
        }
        exit();
        return true;
      }),
    [menu, exit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      const typing = (e.target as HTMLElement).tagName === 'INPUT';
      if (typing) return;
      poke();
      if (k === ' ' || k === 'k' || k === 'MediaPlayPause') {
        e.preventDefault();
        togglePlay();
      } else if (k === 'MediaPlay') void videoRef.current?.play();
      else if (k === 'MediaPause') videoRef.current?.pause();
      else if (k === 'j' || k === 'MediaRewind') seek(-10);
      else if (k === 'l' || k === 'MediaFastForward') seek(10);
      else if (k === 'f') toggleFullscreen();
      else if (k === 'm' && videoRef.current) videoRef.current.muted = !videoRef.current.muted;
      else if (k === 'g' && live) setMenu((m) => (m === 'guide' ? null : 'guide'));
      else if (k === 'c' && subs.length) chooseSub(subSel >= 0 ? -1 : subs[0].id);
      else if (live && (k === 'PageUp' || k === 'ChannelUp')) switchChannel(info?.live?.nextChannel ?? channel?.nextChannel);
      else if (live && (k === 'PageDown' || k === 'ChannelDown')) switchChannel(info?.live?.prevChannel ?? channel?.prevChannel);
      else if (!visible && (k === 'ArrowLeft' || k === 'ArrowRight') && !live) {
        e.preventDefault();
        e.stopPropagation();
        seek(k === 'ArrowLeft' ? -10 : 10);
      } else if (!visible && k.startsWith('Arrow')) {
        e.preventDefault();
        e.stopPropagation();
        focusFirst(rootRef.current ?? document);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // OS media keys / TV remotes via Media Session.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !info) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title,
      artist: info.subtitle ?? (live ? info.live?.now?.title : undefined) ?? 'ATLAS',
      artwork: info.artwork ? [{ src: art(info.artwork, 'w500') ?? info.artwork, sizes: '500x500' }] : [],
    });
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(a, h);
      } catch {
        /* unsupported action */
      }
    };
    set('play', () => void videoRef.current?.play());
    set('pause', () => videoRef.current?.pause());
    set('seekbackward', live ? null : () => seek(-10));
    set('seekforward', live ? null : () => seek(10));
    set('nexttrack', info.nextEpisode ? () => navigate(`/watch/${enc(info.nextEpisode!.id)}`, { replace: true }) : live ? () => switchChannel(info.live?.nextChannel) : null);
    set('previoustrack', live ? () => switchChannel(info.live?.prevChannel) : null);
    return () => {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack'] as MediaSessionAction[]) set(a, null);
    };
  }, [info, live]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- render ---------------- */
  const now = useNow(15_000);
  const nowProg = channel?.now ?? info?.live?.now;
  const nextProg = channel?.next ?? info?.live?.next;
  const verified = qualityFromHeight(size?.h, size?.w);
  const cueCss = useMemo(
    () => `.player video::cue{font-size:${(subtitleStyle.size / 100) * 1.55}rem;background:rgba(0,0,0,${subtitleStyle.background});color:#fff;font-family:var(--font);line-height:1.35;text-shadow:0 1px 3px rgba(0,0,0,.6)}`,
    [subtitleStyle],
  );

  if (loadError) {
    return (
      <div className="player" ref={rootRef}>
        <PlayerError
          title={loadError.data?.code === 'consent' ? 'Connection not allowed yet' : 'Can’t play this'}
          body={loadError.message}
          onBack={exit}
          onSettings={loadError.data?.code === 'consent' ? () => navigate('/settings/sources') : undefined}
        />
      </div>
    );
  }

  return (
    <div
      className={`player ${visible || !playing || failure ? 'show-ui' : 'hide-ui'}`}
      ref={rootRef}
      onMouseMove={poke}
      onPointerDown={poke}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'VIDEO') {
          if (device === 'mobile') setVisible((x) => !x);
          else togglePlay();
        }
      }}
      onDoubleClick={(e) => (e.target as HTMLElement).tagName === 'VIDEO' && toggleFullscreen()}
    >
      <style>{cueCss}</style>
      <video ref={videoRef} playsInline autoPlay style={{ objectFit: fit }} crossOrigin="use-credentials" />

      {(buffering || !info) && !failure && (
        <div className="player-buffer" aria-live="polite">
          {info?.artwork && !playing && <Img src={art(info.artwork, 'w1280')} alt="" className="player-poster loaded" />}
          <div className="spinner" />
          <span className="t-caption">{engineLabel ? `Connecting · ${engineLabel}` : 'Preparing'}</span>
        </div>
      )}

      {failure && (
        <PlayerError
          title={failure.title}
          body={failure.body}
          onBack={exit}
          onRetry={
            failure.kind !== 'unsupported'
              ? () => {
                  sourceIdx.current = 0;
                  attempt.current = 0;
                  void start();
                }
              : undefined
          }
          onSettings={failure.kind === 'expired' ? () => navigate('/settings/sources') : undefined}
          alternates={live ? channel?.alternates : undefined}
          onAlternate={(alt) => switchChannel(alt)}
        />
      )}

      {/* Live channel banner */}
      <AnimatePresence>
        {live && banner && info && !failure && (
          <motion.div className="channel-banner glass" initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <span className="cb-logo">
              <Img src={art(info.live?.logo)} alt="" fallback={<span>{info.title.slice(0, 3)}</span>} />
            </span>
            <span>
              <span className="t-caption tabular">{info.live?.number ?? ''}</span>
              <strong style={{ display: 'block' }}>{info.title}</strong>
              {nowProg && <span className="t-caption">{nowProg.title}</span>}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top bar */}
      <div className="player-top">
        <button className="glass-btn icon lg" onClick={exit} aria-label="Exit player" style={{ width: '3.25rem' }}>
          <IconChevronLeft />
        </button>
        <div className="player-title">
          <span className="t-eyebrow">{live ? `${info?.live?.number ? `${info.live.number} · ` : ''}Live TV` : info?.episode ? `Season ${info.episode.season} · Episode ${info.episode.episode}` : 'Now playing'}</span>
          <h1>{live && nowProg ? nowProg.title : info?.title}</h1>
          <span className="t-caption">{live ? info?.title : info?.episode?.title ?? ''}</span>
        </div>
        <div className="player-badges">
          {live && <span className="badge live">Live</span>}
          {verified && (
            <span className="badge solid" title={`Measured ${size?.w}×${size?.h}`}>
              {verified}
            </span>
          )}
          {engineLabel && <span className="badge">{engineLabel}</span>}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="player-bottom glass" data-focus-zone="player-controls" onMouseEnter={() => window.clearTimeout(hideTimer.current)}>
        {live ? (
          <LiveTimeline now={now} prog={nowProg} next={nextProg} />
        ) : (
          <Scrubber time={time} duration={duration} buffered={buffered} onSeek={(t) => videoRef.current && (videoRef.current.currentTime = t)} />
        )}
        <div className="pc-row">
          <div className="pc-group">
            <button className="pc-btn primary" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} data-autofocus>
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            {!live ? (
              <>
                <button className="pc-btn" onClick={() => seek(-10)} aria-label="Back 10 seconds">
                  <IconBack10 />
                </button>
                <button className="pc-btn" onClick={() => seek(10)} aria-label="Forward 10 seconds">
                  <IconForward10 />
                </button>
                <span className="pc-time tabular">
                  {formatClock(time)} <span style={{ opacity: 0.5 }}>/ {formatClock(duration)}</span>
                </span>
              </>
            ) : (
              <>
                <button className="pc-btn" onClick={() => switchChannel(channel?.prevChannel ?? info?.live?.prevChannel)} aria-label="Previous channel" disabled={!(channel?.prevChannel ?? info?.live?.prevChannel)}>
                  <IconChevronUp />
                </button>
                <button className="pc-btn" onClick={() => switchChannel(channel?.nextChannel ?? info?.live?.nextChannel)} aria-label="Next channel" disabled={!(channel?.nextChannel ?? info?.live?.nextChannel)}>
                  <IconChevronDown />
                </button>
              </>
            )}
            <button className="pc-btn" onClick={() => videoRef.current && (videoRef.current.muted = !videoRef.current.muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
              {muted ? <IconMute /> : <IconVolume />}
            </button>
          </div>
          <div className="pc-group">
            {info?.nextEpisode && (
              <button className="pc-btn wide" onClick={() => navigate(`/watch/${enc(info.nextEpisode!.id)}`, { replace: true })}>
                <IconNext /> Next episode
              </button>
            )}
            {live && (
              <>
                <button className="pc-btn" onClick={() => setMenu(menu === 'guide' ? null : 'guide')} aria-label="Channel guide" aria-expanded={menu === 'guide'}>
                  <IconGuide />
                </button>
                <button className={`pc-btn ${channel?.inList ? 'on' : ''}`} onClick={toggleFavourite} aria-label={channel?.inList ? 'Remove from Favourites' : 'Add to Favourites'} aria-pressed={!!channel?.inList}>
                  <IconStar />
                </button>
              </>
            )}
            <button className="pc-btn" onClick={() => setMenu(menu === 'audio' ? null : 'audio')} aria-label="Audio" aria-expanded={menu === 'audio'} disabled={audio.length < 2}>
              <IconAudio />
            </button>
            <button className={`pc-btn ${subSel >= 0 ? 'on' : ''}`} onClick={() => setMenu(menu === 'subtitles' ? null : 'subtitles')} aria-label="Subtitles" aria-expanded={menu === 'subtitles'}>
              <IconSubtitles />
            </button>
            <button className="pc-btn" onClick={() => setMenu(menu === 'settings' ? null : 'settings')} aria-label="Playback settings" aria-expanded={menu === 'settings'}>
              <IconSettings />
            </button>
            {'pictureInPictureEnabled' in document && document.pictureInPictureEnabled && (
              <button className="pc-btn" onClick={togglePip} aria-label="Picture in Picture">
                <IconPip />
              </button>
            )}
            {device !== 'tv' && (
              <button className="pc-btn" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
                {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Menus */}
      <AnimatePresence>
        {menu && menu !== 'guide' && (
          <motion.div
            className="player-menu glass"
            data-focus-trap
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            onAnimationComplete={() => focusFirst(document.querySelector('.player-menu') ?? document)}
          >
            {menu === 'audio' && (
              <MenuList
                title="Audio"
                items={audio.map((a) => ({ key: a.id, label: a.label, selected: a.id === audioSel, run: () => (engineRef.current?.setAudio(a.id), setAudioSel(a.id)) }))}
                empty="This stream has a single audio track."
              />
            )}
            {menu === 'subtitles' && (
              <>
                <MenuList
                  title="Subtitles"
                  items={[{ key: -1, label: 'Off', selected: subSel < 0, run: () => chooseSub(-1) }, ...subs.map((s) => ({ key: s.id, label: s.label, selected: s.id === subSel, run: () => chooseSub(s.id) }))]}
                />
                <label className="menu-item" tabIndex={0} data-focusable onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.querySelector('input') as HTMLInputElement)?.click()}>
                  <IconUpload /> Load subtitle file (.srt, .vtt)
                  <input type="file" accept=".srt,.vtt,text/vtt" hidden onChange={(e) => e.target.files?.[0] && importSubtitle(e.target.files[0])} />
                </label>
                {subSel >= 0 && (
                  <div className="menu-inline">
                    <span>Sync</span>
                    <button className="glass-btn sm" onClick={() => adjustOffset(-0.5)}>
                      −0.5s
                    </button>
                    <span className="tabular" style={{ minWidth: '3.5rem', textAlign: 'center' }}>
                      {subOffset > 0 ? '+' : ''}
                      {subOffset.toFixed(1)}s
                    </span>
                    <button className="glass-btn sm" onClick={() => adjustOffset(0.5)}>
                      +0.5s
                    </button>
                  </div>
                )}
                <div className="menu-inline">
                  <span>Size</span>
                  {[80, 100, 125, 150].map((s) => (
                    <button key={s} className="chip" aria-pressed={subtitleStyle.size === s} onClick={() => setSubtitleStyle({ size: s })}>
                      {s}%
                    </button>
                  ))}
                </div>
                <div className="menu-inline">
                  <span>Background</span>
                  {[0, 0.35, 0.55, 0.85].map((b) => (
                    <button key={b} className="chip" aria-pressed={subtitleStyle.background === b} onClick={() => setSubtitleStyle({ background: b })}>
                      {b === 0 ? 'None' : `${Math.round(b * 100)}%`}
                    </button>
                  ))}
                </div>
                <p className="t-caption" style={{ padding: '0.4rem 0.9rem 0.2rem' }}>
                  Online subtitle search needs an authorised subtitle service key on the server; it isn’t configured yet.
                </p>
              </>
            )}
            {menu === 'settings' && (
              <>
                {levels.length > 1 && (
                  <MenuList
                    title="Quality"
                    items={[
                      { key: -1, label: `Auto${level === -1 && size ? ` · ${qualityFromHeight(size.h, size.w)}` : ''}`, selected: level === -1, run: () => (engineRef.current?.setLevel(-1), setLevel(-1)) },
                      ...[...levels].reverse().map((l) => ({ key: l.id, label: l.label, selected: l.id === level, run: () => (engineRef.current?.setLevel(l.id), setLevel(l.id)) })),
                    ]}
                  />
                )}
                {!live && (
                  <div className="menu-inline">
                    <span>Speed</span>
                    {[0.75, 1, 1.25, 1.5, 2].map((s) => (
                      <button
                        key={s}
                        className="chip"
                        aria-pressed={speed === s}
                        onClick={() => {
                          if (videoRef.current) videoRef.current.playbackRate = s;
                          setSpeed(s);
                        }}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                )}
                <div className="menu-inline">
                  <IconAspect style={{ width: '1.1rem' }} />
                  <span>Picture</span>
                  {(
                    [
                      ['contain', 'Fit'],
                      ['cover', 'Fill'],
                      ['fill', 'Stretch'],
                    ] as const
                  ).map(([v, l]) => (
                    <button key={v} className="chip" aria-pressed={fit === v} onClick={() => setFit(v)}>
                      {l}
                    </button>
                  ))}
                </div>
                <div className="menu-meta t-caption">
                  {size ? `Decoding ${size.w}×${size.h}` : 'Resolution unknown until playback starts'} · {engineLabel} engine
                  {info && info.sources.length > 1 && (
                    <>
                      {' · '}
                      <button
                        className="link"
                        onClick={() => {
                          setMenu(null);
                          if (!nextSource()) {
                            sourceIdx.current = 0;
                            void start();
                          }
                        }}
                      >
                        Switch engine
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {live && menu === 'guide' && channel?.categoryId && <MiniGuide category={channel.categoryId} current={id} onPick={(c) => (setMenu(null), switchChannel(c))} onClose={() => setMenu(null)} />}

      {/* Up next */}
      <AnimatePresence>
        {upNext && (
          <motion.div className="upnext glass" data-focus-trap initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} onAnimationComplete={() => focusFirst(document.querySelector('.upnext') ?? document)}>
            <div className="upnext-art">
              <Img src={art(upNext.card.backdrop, 'w500')} alt="" />
            </div>
            <div style={{ display: 'grid', gap: '0.35rem' }}>
              <span className="t-eyebrow">Up next</span>
              <strong>{upNext.card.subtitle ?? upNext.card.title}</strong>
              <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.4rem' }}>
                <button className="glass-btn primary sm" onClick={() => navigate(`/watch/${enc(upNext.card.id)}`, { replace: true })} data-autofocus>
                  <IconPlay /> {upNext.seconds > 0 ? `Play in ${upNext.seconds}` : 'Play now'}
                </button>
                <button
                  className="glass-btn sm"
                  onClick={() => {
                    setUpNext(null);
                    setUpNextDismissed(true);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuList({ title, items, empty }: { title: string; items: Array<{ key: number; label: string; selected: boolean; run: () => void }>; empty?: string }) {
  return (
    <div className="menu-section">
      <div className="t-eyebrow" style={{ padding: '0.4rem 0.9rem' }}>
        {title}
      </div>
      {items.length === 0 && empty && <p className="t-caption" style={{ padding: '0 0.9rem 0.6rem' }}>{empty}</p>}
      {items.map((i) => (
        <button key={i.key} className="menu-item" aria-pressed={i.selected} onClick={i.run}>
          <span className="tick">{i.selected && <IconCheck />}</span>
          {i.label}
        </button>
      ))}
    </div>
  );
}

function Scrubber({ time, duration, buffered, onSeek }: { time: number; duration: number; buffered: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pct = duration ? (time / duration) * 100 : 0;
  const bpct = duration ? (buffered / duration) * 100 : 0;
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };
  return (
    <div
      ref={ref}
      className="scrubber"
      role="slider"
      tabIndex={0}
      data-focusable
      data-own-arrows
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        onSeek(at(e.clientX));
      }}
      onPointerMove={(e) => {
        setHover(at(e.clientX));
        if (e.buttons === 1) onSeek(at(e.clientX));
      }}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onSeek(Math.max(0, time - 10));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          onSeek(Math.min(duration, time + 10));
        }
      }}
    >
      <div className="sc-track">
        <span className="sc-buffer" style={{ width: `${bpct}%` }} />
        <span className="sc-fill" style={{ width: `${pct}%` }} />
        <span className="sc-thumb" style={{ left: `${pct}%` }} />
      </div>
      {hover !== null && duration > 0 && (
        <span className="sc-hover tabular" style={{ left: `${(hover / duration) * 100}%` }}>
          {formatClock(hover)}
        </span>
      )}
    </div>
  );
}

function LiveTimeline({ now, prog, next }: { now: number; prog?: { title: string; start: number; stop: number }; next?: { title: string; start: number; stop: number } }) {
  if (!prog) return <div className="live-line t-caption">No guide information for this channel</div>;
  const pct = Math.min(100, Math.max(0, ((now - prog.start) / (prog.stop - prog.start)) * 100));
  return (
    <div className="live-line">
      <span className="tabular t-caption">{timeLabel(prog.start)}</span>
      <div className="sc-track" style={{ flex: 1 }}>
        <span className="sc-fill live" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular t-caption">{timeLabel(prog.stop)}</span>
      {next && <span className="t-caption next">Next: {next.title}</span>}
    </div>
  );
}

function MiniGuide({ category, current, onPick, onClose }: { category: string; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const query = useBrowse('channels', { category });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!items.length) return;
    const el = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? listRef.current?.querySelector<HTMLElement>('button');
    el?.focus({ preventScroll: false });
  }, [items.length]);
  return (
    <motion.aside className="mini-guide glass" data-focus-trap initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} aria-label="Channels">
      <div className="mg-head">
        <strong>Channels</strong>
        <button className="glass-btn sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="mg-list" ref={listRef} data-scroll-y>
        {items.map((c) => (
          <button key={c.id} className="mg-item" aria-current={c.id === current} onClick={() => onPick(c.id)}>
            <span className="num tabular">{c.number}</span>
            <span className="mg-logo">
              <Img src={art(c.logo)} alt="" fallback={<span />} />
            </span>
            <span className="mg-text">
              <span className="name">{c.title}</span>
              <span className="t-caption">{c.now?.title ?? ''}</span>
            </span>
          </button>
        ))}
        {query.hasNextPage && (
          <button className="mg-item" onClick={() => query.fetchNextPage()}>
            Load more…
          </button>
        )}
      </div>
    </motion.aside>
  );
}

function PlayerError({
  title,
  body,
  onBack,
  onRetry,
  onSettings,
  alternates,
  onAlternate,
}: {
  title: string;
  body: string;
  onBack: () => void;
  onRetry?: () => void;
  onSettings?: () => void;
  alternates?: Array<{ id: string; title: string; category?: string }>;
  onAlternate?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) focusFirst(ref.current);
  }, [title]);
  return (
    <div className="player-error" ref={ref} data-focus-trap role="alert">
      <div className="pe-card glass">
        <h2>{title}</h2>
        <p className="t-body">{body}</p>
        <div className="actions">
          {onRetry && (
            <button className="glass-btn primary" onClick={onRetry} data-autofocus>
              Retry
            </button>
          )}
          {onSettings && (
            <button className="glass-btn" onClick={onSettings}>
              Open Settings
            </button>
          )}
          <button className="glass-btn" onClick={onBack}>
            Back
          </button>
        </div>
        {alternates && alternates.length > 0 && onAlternate && (
          <div className="pe-alts">
            <span className="t-eyebrow">Other feeds for this channel from your provider</span>
            {alternates.map((a) => (
              <button key={a.id} className="menu-item" onClick={() => onAlternate(a.id)}>
                <IconPlay style={{ width: '1rem' }} /> {a.title}
                {a.category && <span className="t-caption" style={{ marginLeft: 'auto' }}>{a.category}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
