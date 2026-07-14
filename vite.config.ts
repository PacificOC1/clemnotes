import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// NOTE: set `base` to '/<your-repo-name>/' before deploying to GitHub Pages,
// e.g. base: '/outliner-app/'. Leave as '/' for local dev and other hosts.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/outliner-app/' : '/',
})
