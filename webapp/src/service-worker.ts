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

// The SSE endpoint is a long-lived event stream. It must never be handled by
// the service worker: NetworkFirst would try to buffer the never-ending
// response to cache it and, after networkTimeoutSeconds, abort the request
// (NS_BINDING_ABORTED), breaking EventSource. Let it go straight to the network.
const SSE_PATH = '/api/v1/events';

// API caching strategy - Network First with offline fallback
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/v1/') && url.pathname !== SSE_PATH,
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
// safe to retry via background sync. All other POSTs (e.g., note creation,
// import, duplicate, image upload) would create duplicates since the server
// generates a new random ID per request. Login is also excluded: answering it
// with a synthetic 202 would flip the client into an authenticated state with
// no user data.
const retryablePostPaths = new Set([
  '/api/v1/logout',
  '/api/v1/notes/reorder',
]);

// POST paths with dynamic segments that are safe to retry. Each endpoint is
// matched exactly — a bare prefix like '/api/v1/notes/' would also capture
// non-idempotent endpoints (/notes/import, /notes/{id}/duplicate,
// /notes/{id}/images) that must never be replayed, nor answered with a
// synthetic 202 whose plain-text body their callers would misread as a real
// response.
const retryablePostPatterns = [
  /^\/api\/v1\/notes\/[^/]+\/(share|restore|labels)$/,
  /^\/api\/v1\/notes\/[^/]+\/items\/reorder$/,
  /^\/api\/v1\/notes\/[^/]+\/items\/[^/]+\/toggle-completed$/,
];

const isRetryablePost = (pathname: string): boolean => {
  if (retryablePostPaths.has(pathname)) return true;
  return retryablePostPatterns.some(pattern => pattern.test(pathname));
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