/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';
import { Queue } from 'workbox-background-sync';

// Precache the whole build — index.html and every hashed asset it references.
// This is the only thing that serves build output: the precache swaps all of it
// at once on activate, so the shell and the assets it points at are always from
// the same build. A runtime route for scripts/styles would defeat that by
// answering for asset URLs the current precache has never heard of.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Caches written by earlier revisions of this file. 'navigations' held a
// stale-while-revalidate copy of the app shell and 'static-assets' a
// cache-first copy of the hashed build assets, so after a deployment the two
// could disagree about which build was current. cleanupOutdatedCaches() only
// removes outdated *precaches*, so these have to be dropped by name to get
// existing installations off them.
const LEGACY_CACHES = ['navigations', 'static-assets'];

// The SSE endpoint is a long-lived event stream. It must never be handled by
// the service worker: NetworkFirst would try to buffer the never-ending
// response to cache it and, after networkTimeoutSeconds, abort the request
// (NS_BINDING_ABORTED), breaking EventSource. Let it go straight to the network.
const SSE_PATH = '/api/v1/events';

// Note images are immutable for a given ID — the ID is minted per upload and
// the bytes behind it never change — so cache-first is safe here in a way it is
// not for build assets. Registered ahead of the API route below, which would
// otherwise claim these URLs and re-fetch every image on every load.
registerRoute(
  ({ url }) => /^\/api\/v1\/images\/[^/]+(\/thumbnail)?$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'note-images',
  })
);

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

// Serve every in-app route from the precached shell. Binding the handler to the
// precache (rather than caching navigation responses separately) is what keeps
// the HTML and the hashed assets it references on the same build: a deployment
// replaces both together, so a reload can never load a shell that asks for
// assets the server no longer has.
//
// Anything under /api/ is denied: /api/docs/index.html (Swagger UI) is a
// navigation the server owns, and handing it the SPA shell would replace it.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  })
);

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
// /notes/{id}/images) that must never be replayed. Beyond idempotency, an
// endpoint only qualifies if its client ignores the response body: a queued
// request is answered with the synthetic 202 plain-text response below, which
// a body-reading caller would misparse (that rules out /notes/{id}/restore,
// /notes/{id}/labels and .../toggle-completed, whose clients read the
// returned note/items).
const retryablePostPatterns = [
  /^\/api\/v1\/notes\/[^/]+\/share$/,
  /^\/api\/v1\/notes\/[^/]+\/items\/reorder$/,
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
  event.waitUntil(
    (async () => {
      await Promise.all(LEGACY_CACHES.map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});