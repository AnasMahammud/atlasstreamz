import type { PlaybackSource } from './api.ts';

/**
 * Playback engines behind one interface. hls.js for HLS where MSE exists (native HLS on
 * Safari/iOS), mpegts.js for raw MPEG-TS live streams, the browser itself for files.
 * Each engine reports fatal errors upward so the player's recovery logic can decide
 * whether to retry, recover, or move on to the next engine.
 */

export type FatalKind = 'network' | 'media' | 'unsupported' | 'auth' | 'other';

export interface Track {
  id: number;
  label: string;
  lang?: string;
}

export interface Level {
  id: number;
  height: number;
  bitrate: number;
  label: string;
}

export interface EngineHandle {
  engine: PlaybackSource['engine'];
  destroy(): void;
  levels(): Level[];
  currentLevel(): number;
  setLevel(id: number): void;
  audioTracks(): Track[];
  currentAudio(): number;
  setAudio(id: number): void;
  subtitleTracks(): Track[];
  currentSubtitle(): number;
  setSubtitle(id: number): void;
  /** Ask the engine to retry after a network problem. Returns false if it can't. */
  retry(): boolean;
  /** Try to recover from a decode error in place. Returns false if exhausted. */
  recoverMedia(): boolean;
  capQuality(maxHeight: number | null): void;
}

export interface EngineEvents {
  onFatal: (kind: FatalKind, detail: string) => void;
  onTracksChanged: () => void;
}

export function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function langLabel(lang?: string, name?: string): string {
  if (name && name.trim()) return name;
  if (!lang) return 'Unknown';
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

export async function attachEngine(video: HTMLVideoElement, source: PlaybackSource, opts: { live: boolean; events: EngineEvents; startAt?: number; lowMemory?: boolean }): Promise<EngineHandle> {
  const { events } = opts;
  if (source.engine === 'hls') {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported() && canPlayNativeHls(video)) return attachNative(video, source.url, events, 'hls');
    if (!Hls.isSupported()) {
      events.onFatal('unsupported', 'This browser can’t play HLS streams.');
      throw new Error('hls unsupported');
    }
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: opts.lowMemory ? 10 : opts.live ? 30 : 60,
      maxBufferLength: opts.lowMemory ? 15 : 30,
      maxMaxBufferLength: opts.lowMemory ? 30 : 120,
      startPosition: opts.startAt && opts.startAt > 0 ? opts.startAt : -1,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 4,
      capLevelToPlayerSize: true,
      xhrSetup: (xhr) => {
        xhr.withCredentials = true;
      },
    });
    let mediaRecoveries = 0;
    let networkRetries = 0;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      const code = (data.response as { code?: number } | undefined)?.code;
      if (code === 401 || code === 403) return events.onFatal('auth', `Stream refused (${code})`);
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) return events.onFatal('network', data.details);
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return events.onFatal('media', data.details);
      events.onFatal('other', data.details);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => events.onTracksChanged());
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => events.onTracksChanged());
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => events.onTracksChanged());
    hls.on(Hls.Events.LEVEL_SWITCHED, () => events.onTracksChanged());
    hls.on(Hls.Events.FRAG_LOADED, () => {
      networkRetries = 0;
    });
    hls.loadSource(source.url);
    hls.attachMedia(video);
    return {
      engine: 'hls',
      destroy: () => hls.destroy(),
      levels: () =>
        hls.levels.map((l, i) => ({ id: i, height: l.height, bitrate: l.bitrate, label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps` })),
      currentLevel: () => (hls.autoLevelEnabled ? -1 : hls.currentLevel),
      setLevel: (id) => {
        hls.currentLevel = id;
      },
      audioTracks: () => hls.audioTracks.map((t, i) => ({ id: i, label: langLabel(t.lang, t.name), lang: t.lang })),
      currentAudio: () => hls.audioTrack,
      setAudio: (id) => {
        hls.audioTrack = id;
      },
      subtitleTracks: () => hls.subtitleTracks.map((t, i) => ({ id: i, label: langLabel(t.lang, t.name), lang: t.lang })),
      currentSubtitle: () => hls.subtitleTrack,
      setSubtitle: (id) => {
        hls.subtitleTrack = id;
        hls.subtitleDisplay = id >= 0;
      },
      retry: () => {
        if (networkRetries >= 3) return false;
        networkRetries++;
        hls.startLoad();
        return true;
      },
      recoverMedia: () => {
        if (mediaRecoveries === 0) hls.recoverMediaError();
        else if (mediaRecoveries === 1) {
          hls.swapAudioCodec();
          hls.recoverMediaError();
        } else return false;
        mediaRecoveries++;
        return true;
      },
      capQuality: (maxHeight) => {
        if (maxHeight === null) {
          hls.autoLevelCapping = -1;
          return;
        }
        const idx = hls.levels.reduce((best, l, i) => (l.height && l.height <= maxHeight ? i : best), -1);
        hls.autoLevelCapping = idx;
      },
    };
  }

  if (source.engine === 'mpegts') {
    const mpegts = (await import('mpegts.js')).default;
    if (!mpegts.getFeatureList().mseLivePlayback) {
      events.onFatal('unsupported', 'This browser can’t play MPEG-TS streams.');
      throw new Error('mpegts unsupported');
    }
    const player = mpegts.createPlayer(
      { type: 'mpegts', isLive: opts.live, url: new URL(source.url, location.href).toString(), withCredentials: true },
      { enableWorker: true, lazyLoad: !opts.live, liveBufferLatencyChasing: opts.live, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 1.5, autoCleanupSourceBuffer: true },
    );
    player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
      if (type === mpegts.ErrorTypes.NETWORK_ERROR) events.onFatal(/403|401/.test(detail) ? 'auth' : 'network', detail);
      else if (type === mpegts.ErrorTypes.MEDIA_ERROR) events.onFatal('media', detail);
      else events.onFatal('other', detail);
    });
    player.attachMediaElement(video);
    player.load();
    let retries = 0;
    return {
      engine: 'mpegts',
      destroy: () => {
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
        } finally {
          player.destroy();
        }
      },
      levels: () => [],
      currentLevel: () => -1,
      setLevel: () => {},
      audioTracks: () => [],
      currentAudio: () => -1,
      setAudio: () => {},
      subtitleTracks: () => [],
      currentSubtitle: () => -1,
      setSubtitle: () => {},
      retry: () => {
        if (retries >= 2) return false;
        retries++;
        player.unload();
        player.load();
        void player.play();
        return true;
      },
      recoverMedia: () => false,
      capQuality: () => {},
    };
  }

  return attachNative(video, source.url, events, 'native', source.mime);
}

function attachNative(video: HTMLVideoElement, url: string, events: EngineEvents, engine: EngineHandle['engine'], mime?: string): EngineHandle {
  if (mime && video.canPlayType(mime) === '' && !/matroska|x-msvideo|quicktime/.test(mime)) {
    // Known-unsupported container: fail fast instead of a long timeout.
    events.onFatal('unsupported', `This device can’t play ${mime}.`);
  }
  let retries = 0;
  const onError = () => {
    const err = video.error;
    if (!err) return;
    if (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) events.onFatal('unsupported', err.message || 'Format not supported');
    else if (err.code === MediaError.MEDIA_ERR_NETWORK) events.onFatal('network', err.message || 'Network error');
    else if (err.code === MediaError.MEDIA_ERR_DECODE) events.onFatal('media', err.message || 'Decode error');
    else events.onFatal('other', err.message || 'Playback error');
  };
  video.addEventListener('error', onError);
  const tracksChanged = () => events.onTracksChanged();
  video.textTracks.addEventListener?.('addtrack', tracksChanged);
  (video as any).audioTracks?.addEventListener?.('addtrack', tracksChanged);
  video.src = url;
  video.load();
  return {
    engine,
    destroy: () => {
      video.removeEventListener('error', onError);
      video.textTracks.removeEventListener?.('addtrack', tracksChanged);
      video.removeAttribute('src');
      video.load();
    },
    levels: () => [],
    currentLevel: () => -1,
    setLevel: () => {},
    audioTracks: () => {
      const list = (video as any).audioTracks as { length: number; [i: number]: { label: string; language: string; enabled: boolean } } | undefined;
      if (!list) return [];
      return Array.from({ length: list.length }, (_, i) => ({ id: i, label: langLabel(list[i].language, list[i].label), lang: list[i].language }));
    },
    currentAudio: () => {
      const list = (video as any).audioTracks;
      if (!list) return -1;
      for (let i = 0; i < list.length; i++) if (list[i].enabled) return i;
      return -1;
    },
    setAudio: (id) => {
      const list = (video as any).audioTracks;
      if (!list) return;
      for (let i = 0; i < list.length; i++) list[i].enabled = i === id;
    },
    subtitleTracks: () =>
      Array.from(video.textTracks)
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.kind === 'subtitles' || t.kind === 'captions')
        .map(({ t, i }) => ({ id: i, label: langLabel(t.language, t.label), lang: t.language })),
    currentSubtitle: () => Array.from(video.textTracks).findIndex((t) => t.mode === 'showing'),
    setSubtitle: (id) => {
      Array.from(video.textTracks).forEach((t, i) => {
        t.mode = i === id ? 'showing' : 'disabled';
      });
    },
    retry: () => {
      if (retries >= 2) return false;
      retries++;
      const t = video.currentTime;
      video.load();
      video.currentTime = t;
      void video.play().catch(() => {});
      return true;
    },
    recoverMedia: () => false,
    capQuality: () => {},
  };
}
