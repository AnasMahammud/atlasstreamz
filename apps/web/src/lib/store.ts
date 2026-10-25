import { create } from 'zustand';
import { accentFor } from './color.ts';
import { storageGet, storageSet, type DeviceClass } from './device.ts';

export interface Appearance {
  theme: 'dark' | 'light';
  motion: 'system' | 'reduced';
  transparency: 'normal' | 'reduced';
  scale: 'small' | 'normal' | 'large';
}

export interface SubtitleStyle {
  size: number;
  background: number;
}

interface ToastItem {
  id: number;
  text: string;
  tone?: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

interface UiState {
  device: DeviceClass;
  ambientImage?: string;
  appearance: Appearance;
  subtitleStyle: SubtitleStyle;
  toasts: ToastItem[];
  setDevice: (d: DeviceClass) => void;
  setAmbient: (image?: string) => void;
  setAppearance: (a: Partial<Appearance>) => void;
  setSubtitleStyle: (s: Partial<SubtitleStyle>) => void;
  toast: (text: string, opts?: { tone?: ToastItem['tone']; action?: ToastItem['action']; ms?: number }) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;
let ambientTimer: number | undefined;

export const useUi = create<UiState>((set, get) => ({
  device: 'desktop',
  ambientImage: undefined,
  appearance: storageGet<Appearance>('atlas.appearance', { theme: 'dark', motion: 'system', transparency: 'normal', scale: 'normal' }),
  subtitleStyle: storageGet<SubtitleStyle>('atlas.subtitles', { size: 100, background: 0.55 }),
  toasts: [],
  setDevice: (device) => set({ device }),
  setAmbient: (image) => {
    // Debounced so rapid focus movement across a shelf doesn't thrash the background.
    window.clearTimeout(ambientTimer);
    ambientTimer = window.setTimeout(() => {
      if (get().ambientImage === image) return;
      set({ ambientImage: image });
      void accentFor(image).then((rgb) => {
        if (rgb && get().ambientImage === image) document.documentElement.style.setProperty('--accent', rgb);
      });
    }, 180);
  },
  setAppearance: (a) => {
    const appearance = { ...get().appearance, ...a };
    storageSet('atlas.appearance', appearance);
    applyAppearance(appearance);
    set({ appearance });
  },
  setSubtitleStyle: (s) => {
    const subtitleStyle = { ...get().subtitleStyle, ...s };
    storageSet('atlas.subtitles', subtitleStyle);
    set({ subtitleStyle });
  },
  toast: (text, opts = {}) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-2), { id, text, tone: opts.tone, action: opts.action }] });
    window.setTimeout(() => get().dismissToast(id), opts.ms ?? 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.dataset.transparency = a.transparency;
  root.dataset.scale = a.scale;
  if (a.motion === 'reduced') root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
}

export const toast = (text: string, opts?: Parameters<UiState['toast']>[1]) => useUi.getState().toast(text, opts);
