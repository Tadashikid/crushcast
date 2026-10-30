import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two pages in one build: control room at /, phone page at /join/. Dev server proxies the relay on :8080.
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { control: 'index.html', join: 'join/index.html' } } },
  server: {
    host: true,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true }, '/api': 'http://localhost:8080' },
  },
});
