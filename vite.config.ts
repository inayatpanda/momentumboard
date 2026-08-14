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
        // `motion` stays IN the entry deliberately (CX-21) — it is ~3 KB and
        // load-bearing for route transitions; a separate chunk just adds a
        // request.
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
      registerType: 'autoUpdate',
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png}'] },
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
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts']
  }
})
