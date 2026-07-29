import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build can be served from any sub-path (e.g. GitHub Pages).
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
