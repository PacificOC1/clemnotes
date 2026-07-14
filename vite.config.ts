import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Base path matches the GitHub repo name (clemnotes) since that's the
// subpath GitHub Pages serves this project under.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/clemnotes/' : '/',
})
