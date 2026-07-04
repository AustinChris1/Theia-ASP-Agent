import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite + React + Tailwind v4 (via the official Vite plugin — no postcss/config
// files needed). Vercel auto-detects this as a Vite app: build = `vite build`,
// output = `dist`. Nothing else to configure.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
