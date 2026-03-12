/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { StaleWhileRevalidate, NetworkFirst, CacheFirst } from 'workbox-strategies';
import { Queue } from 'workbox-background-sync';

// Precache all static assets
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Cache strategy for static assets (CSS, JS, images)
registerRoute(
  ({ request }) => request.destination === 'script' || 
                   request.destination === 'style' ||
                   request.destination === 'image',
  new CacheFirst({
    cacheName: 'static-assets',
    plugins: [
      {
        cacheKeyWillBeUsed: async ({ request }) => {
          return `${request.url}`;
        },
      },
    ],
  })
);

// API caching strategy - Network First with offline fallback
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/v1/'),
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 3,
    plugins: [
      {
        cacheWillUpdate: async ({ response }) => {
          // Only cache successful responses
          return response.status === 200 ? response : null;
        },
        cacheKeyWillBeUsed: async ({ request }) => {
          // Create cache key ignoring only safe-to-ignore query parameters for GET requests
          if (request.method === 'GET') {
            const url = new URL(request.url);
            // Only remove specific query parameters that don't affect the response
            const paramsToIgnore = ['_t', 'timestamp', 'cache_bust'];
            paramsToIgnore.forEach(param => url.searchParams.delete(param));
            return url.toString();
          }
          return request.url;
        },
      },
    ],
  })
);

// Background sync for failed API requests with retry limits
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

const bgSyncQueue = new Queue('api-queue', {
  onSync: async ({ queue }) => {
    let entry;
    while ((entry = await queue.shiftRequest())) {
      const retryCount = (entry.metadata as { retryCount?: number })?.retryCount || 0;
      
      try {
        await fetch(entry.request);
        // Success - don't re-add to queue
      } catch {
        if (retryCount < MAX_RETRY_COUNT) {
          // Add delay before retry and increment counter
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, retryCount)));
          await queue.unshiftRequest({
            ...entry,
            metadata: { retryCount: retryCount + 1 }
          });
        }
        // Max retries reached - drop the request and continue with next item
      }
    }
  },
});

// Handle navigation requests with cached app shell
const navigationRoute = new NavigationRoute(
  new StaleWhileRevalidate({
    cacheName: 'navigations',
  })
);
registerRoute(navigationRoute);

// Only POST endpoints that are idempotent or have uniqueness constraints are
// safe to retry via background sync. All other POSTs (e.g., note creation)
// would create duplicates since the server generates a new random ID per request.
const retryablePostPaths = new Set([
  '/api/v1/login',
  '/api/v1/logout',
  '/api/v1/notes/reorder',
]);

// POST paths with dynamic segments that are safe to retry (matched by prefix).
const retryablePostPrefixes = [
  '/api/v1/notes/', // covers /notes/{id}/share, /notes/{id}/restore, /notes/{id}/labels
];

const isRetryablePost = (pathname: string): boolean => {
  if (retryablePostPaths.has(pathname)) return true;
  return retryablePostPrefixes.some(prefix => pathname.startsWith(prefix));
};

// Handle non-GET API requests via fetch event listener directly, since
// workbox's registerRoute defaults to GET-only matching.
self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  if (request.method === 'GET') return;

  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v1/')) return;

  // Only retry POSTs that are explicitly allowlisted as idempotent.
  // All other POSTs (note creation, import, register, etc.) fall through
  // to the browser's default fetch so failures propagate to the frontend.
  if (request.method === 'POST' && !isRetryablePost(url.pathname)) {
    return;
  }

  // Idempotent requests (PUT, DELETE, allowlisted POSTs) - queue for
  // background sync on network failure
  event.respondWith(
    fetch(request.clone()).catch(async () => {
      await bgSyncQueue.pushRequest({ request });
      return new Response('Request queued for background sync', {
        status: 202,
        statusText: 'Accepted',
      });
    })
  );
});

// Activate new service worker immediately on install.
// The 'controlling' event in the client triggers a page reload.
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Handle activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});