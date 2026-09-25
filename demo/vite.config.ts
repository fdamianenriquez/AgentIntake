import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Anchored explicitly rather than relying on cwd, since this config may be
// invoked from the repo root (e.g. `vite --config demo/vite.config.ts`).
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/demo', import.meta.url)),
    emptyOutDir: true,
  },
});
