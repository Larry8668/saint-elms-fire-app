import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The university staff portal. `server/uni` serves this build from `/admin`, so the assets
 * share the uni's origin — the only reason the HttpOnly session cookie reaches `/v1/auth/*`.
 * Its own output directory keeps the desktop and onboarding builds untouched.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  publicDir: false,
});