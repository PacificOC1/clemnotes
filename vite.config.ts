import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { serviceWorker } from './scripts/service-worker.ts'

// https://vite.dev/config/
// Base path matches the GitHub repo name (clemnotes) since that's the
// subpath GitHub Pages serves this project under.
export default defineConfig({
  plugins: [react(), serviceWorker()],
  base: process.env.GITHUB_PAGES ? '/clemnotes/' : '/',
  build: {
    // Read by scripts/check-bundle.mjs to work out what loads at startup.
    manifest: true,
  },
})
