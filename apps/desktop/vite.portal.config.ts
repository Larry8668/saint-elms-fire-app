import { rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The university-hosted onboarding shell. It is served by `server/uni` from `/app` out of
 * `dist-portal`, on the uni's own origin — which is the only way the HttpOnly session cookie
 * reaches `/v1/auth/*`. A separate config (not a second entry in `vite.config.ts`) keeps the
 * Tauri/desktop build and its pre-bundled three.js chunk completely untouched.
 */

const OUT_DIR = 'dist-portal';
const SHELL_SOURCE = 'app.html';

/**
 * Vite names an emitted page after its source file, but `server/uni` resolves `/app` to
 * `index.html`. The asset URLs inside the shell are already absolute (`/app/assets/…`), so
 * renaming the file after the build cannot break them. A missing shell fails the build
 * rather than shipping a `/app` that the server cannot resolve.
 */
function shellAsIndex(): Plugin {
  return {
    name: 'sef:portal-shell-as-index',
    apply: 'build',
    async closeBundle() {
      const root = path.dirname(fileURLToPath(import.meta.url));
      const from = path.join(root, OUT_DIR, SHELL_SOURCE);
      await rename(from, path.join(root, OUT_DIR, 'index.html'));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), shellAsIndex()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  base: '/app/',
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: fileURLToPath(new URL(`./${SHELL_SOURCE}`, import.meta.url)),
    },
  },
  // The shell ships no static assets of its own; `public/` belongs to the desktop app.
  publicDir: false,
});