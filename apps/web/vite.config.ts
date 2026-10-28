import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import legacyTvCss from './legacy-css.mjs';

const api = process.env.ATLAS_API ?? 'http://127.0.0.1:4870';

// Oldest browsers the build supports. LG webOS 5 TVs (2020) run Chromium 68, webOS 6 runs 79
// and webOS 22 runs 87; Fire TV and Android TV WebViews, phones and desktops are newer.
const targets = ['chrome68', 'edge79', 'firefox78', 'safari14'];

export default defineConfig({
  plugins: [
    react(),
    // No separate legacy bundle (every target has ES modules): this only adds the runtime
    // APIs Chromium 68 lacks that the bundle calls unguarded (TanStack Query reads
    // globalThis, Framer Motion calls queueMicrotask, the catalogue uses flatMap). An explicit
    // list, because core-js's usage detection pulls in ~75 kB here. Modern browsers skip them.
    legacy({
      modernPolyfills: [
        'es.global-this',
        'web.queue-microtask',
        'es.array.flat',
        'es.array.flat-map',
        'es.array.unscopables.flat',
        'es.array.unscopables.flat-map',
        'es.object.from-entries',
        'es.promise.all-settled',
      ],
      renderLegacyChunks: false,
    }),
  ],
  css: {
    postcss: { plugins: [legacyTvCss()] },
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false, ws: false },
    },
  },
  build: {
    target: targets,
    cssTarget: targets,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          motion: ['framer-motion'],
          players: ['hls.js', 'mpegts.js'],
        },
      },
    },
  },
});
