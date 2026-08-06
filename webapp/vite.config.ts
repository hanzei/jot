/// <reference types="vitest" />
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'url';

export default defineConfig(({ mode }) => ({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      includeAssets: ['favicon.ico', 'icon.svg'],
      manifest: {
        name: 'Jot - Your Personal Note Taker',
        short_name: 'Jot',
        description: 'A simple and elegant note-taking application',
        theme_color: '#4f46e5',
        background_color: '#f8fafc',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icon.svg',
            sizes: '192x192 512x512',
            type: 'image/svg+xml',
            purpose: 'maskable any'
          },
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          }
        ],
        // Long-press the installed PWA's icon to jump straight into a new note
        // or list, skipping the dashboard entirely (deep-links to /new, which
        // Dashboard opens the note modal for).
        shortcuts: [
          {
            name: 'New note',
            short_name: 'New note',
            description: 'Create a new text note',
            url: '/new?type=text',
            icons: [
              { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }
            ]
          },
          {
            name: 'New list',
            short_name: 'New list',
            description: 'Create a new checklist',
            url: '/new?type=list',
            icons: [
              { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }
            ]
          }
        ],
        // Lets the installed PWA appear in the OS share sheet. Shared
        // title/text/url land as query params on /new, which prefills a new
        // text note with them (GET is sufficient since no files are shared).
        share_target: {
          action: '/new',
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url'
          }
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@jot/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/v1': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/livez': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/readyz': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'build',
    minify: mode === 'development' ? false : 'esbuild',
    sourcemap: mode === 'development',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['node_modules/**', 'e2e/**'],
  },
}));