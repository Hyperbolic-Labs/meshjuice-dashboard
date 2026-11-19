import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the build works from any sub-path,
  // e.g. https://<user>.github.io/<repo>/ on GitHub Pages.
  base: './',
  plugins: [svelte()],
})
