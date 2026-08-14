import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Served at https://growthmap.suvera.com (GitHub Pages custom domain,
  // set 2026-08-14) — assets live at the domain root. The old
  // will-suvera.github.io/Tech-growth-map URL 301s to the custom domain.
  base: '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
})
