import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.ATLAS_API ?? 'http://127.0.0.1:4870';

export default defineConfig({
  plugins: [react()],
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
    target: 'es2020',
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
