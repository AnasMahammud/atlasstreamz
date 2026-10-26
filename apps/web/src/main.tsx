import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/glass.css';
import './styles/layout.css';
import './styles/screens.css';
import './styles/player.css';
import { App } from './App.tsx';
import { queryClient } from './lib/queries.ts';
import { detectDevice, trackInputMode } from './lib/device.ts';
import { installSpatialNavigation, nativeBack } from './lib/focus.ts';
import { applyAppearance, useUi } from './lib/store.ts';

const device = detectDevice();
document.documentElement.dataset.device = device;
useUi.getState().setDevice(device);
applyAppearance(useUi.getState().appearance);
trackInputMode();
installSpatialNavigation();

// iOS Safari ignores user-scalable=no; block its pinch gestures directly.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });

// Hooks for the ATLAS Android app: its Back key, and returning from the native player.
Object.assign(window, {
  __atlasBack: () => nativeBack(),
  __atlasResumed: () => void queryClient.invalidateQueries(),
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
