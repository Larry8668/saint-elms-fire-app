import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed port and must see Rust compile errors, so don't clear the screen.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The repo keeps a single .env at its root (see .env.example); Vite would otherwise only
  // look beside this config and VITE_DEMO_MODE/VITE_UNI_URL from that file would never land.
  envDir: '../..',
  // Pre-bundle three up front so the first sky render does not trigger a dependency re-optimisation reload.
  optimizeDeps: {
    include: ['three', '@react-three/fiber'],
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || 'localhost',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
