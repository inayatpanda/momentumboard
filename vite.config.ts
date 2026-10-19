/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Vendor split (plan Task 11): app edits stop busting React's cache.
        // `motion` stays IN the entry deliberately (DS-2/DS-21 — CX-21 is the
        // T212 removal and has nothing to do with chunking): it is ~3 KB and
        // load-bearing for route transitions, so a separate chunk would only
        // add a request.
        manualChunks: {
          react: ['react', 'react-dom'],
          data: ['dexie'],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // 'prompt': a new SW WAITS; the UpdateBanner asks the reader (CX-8).
      registerType: 'prompt',
      // Precache = the ENTRY CLOSURE only (CX-7): shell + vendor + styles +
      // fonts + icons. Lazy screen chunks are CacheFirst at runtime instead of
      // being force-downloaded on first visit (the old glob shipped 943 KB).
      injectManifest: {
        // workbox-window is EAGERLY imported by the entry — omit it and a
        // first-visit-then-offline install fails its import (codex cutover
        // review #5). Manifest icons + manifest.webmanifest are auto-added by
        // VitePWA — globbing them too precached each twice.
        globPatterns: ['index.html', 'assets/index-*.js', 'assets/react-*.js', 'assets/data-*.js', 'assets/workbox-window*.js', 'assets/index-*.css', 'fonts/*.woff2', 'apple-touch-icon.png'],
      },
      manifest: {
        id: '/',
        start_url: '/app/',
        scope: '/app/',
        name: 'StreetSignal',
        short_name: 'StreetSignal',
        description: 'Watchlist, setups and alerts for swing trading. Informs; does not predict.',
        theme_color: '#10131f',
        background_color: '#10131f',
        display: 'standalone',
        // Only `/app/` is in scope: typing the root domain remains a website
        // visit even when StreetSignal is installed on the device.
        launch_handler: { client_mode: 'navigate-existing' },
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
        ]
      }
    })
  ],
  test: {
    include: ['{src,shared,netlify,functions,workers,scripts}/**/*.{test,spec}.{ts,tsx,mts}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts']
  }
})
