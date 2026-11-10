/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'url';
import { execSync } from 'child_process';

// The bundle's own build, for Settings > About and the diagnostics report. It
// can differ from the server's: the service worker keeps serving a cached
// bundle until the user accepts the update prompt. The Docker build passes
// both values; elsewhere the commit comes from git when there is a checkout.
function gitCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

// The server swaps these blocks of index.html for a public link's preview card
// (server/internal/server/share_preview.go, #1209), finding them by their
// marker comments. Fail the build if the emitted index.html lost one, rather
// than letting every share link silently fall back to the generic card.
const PREVIEW_MARKERS = [
  '<!-- jot-preview:text -->', '<!-- /jot-preview:text -->',
  '<!-- jot-preview:image -->', '<!-- /jot-preview:image -->',
];

function requirePreviewMarkers(): Plugin {
  return {
    name: 'jot:require-preview-markers',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') {
        return;
      }
      const html = typeof index.source === 'string' ? index.source : new TextDecoder().decode(index.source);
      const missing = PREVIEW_MARKERS.filter((marker) => !html.includes(marker));
      if (missing.length > 0) {
        this.error(`index.html lost its link-preview markers: ${missing.join(', ')}`);
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  define: {
    __JOT_WEBAPP_VERSION__: JSON.stringify(process.env.JOT_BUILD_VERSION || 'dev'),
    __JOT_WEBAPP_COMMIT__: JSON.stringify(process.env.JOT_BUILD_COMMIT || gitCommit()),
  },
  plugins: [
    tailwindcss(),
    react(),
    requirePreviewMarkers(),
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
    // Vitest replaces every CSS import with an empty string unless it is listed
    // here — `?raw` included. codeHighlightStyles.test.ts reads index.css raw
    // to pin its highlight colours to the shared palette.
    css: { include: [/src\/index\.css/] },
  },
}));