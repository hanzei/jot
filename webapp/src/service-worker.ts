/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';
import { Queue } from 'workbox-background-sync';
import { API_BASE_PATH, PUBLIC_NOTE_PATH_PREFIX, apiPaths } from '@jot/shared';
import { API_CACHE, CLEAR_USER_DATA_MESSAGE, NOTE_IMAGES_CACHE } from './utils/serviceWorkerProtocol';

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

// The unauthenticated public note API (a note and its images through a public
// link). Never cached: a revoked or expired link must stop showing the note at
// once, which a NetworkFirst copy would undo whenever the network is slow, and
// a visitor's device should not keep the note after they leave. The server
// sends `Cache-Control: no-store`, but Workbox's runtime caches ignore it.
const PUBLIC_API_PREFIX = API_BASE_PATH + apiPaths.publicNote('');

// Public link management (create, change expiry, revoke) is online-only: a
// queued PUT or DELETE replayed later would publish or revoke a note long after
// the user saw the request fail.
const PUBLIC_LINK_PATH = new RegExp(`^${API_BASE_PATH}${apiPaths.notePublicLink('[^/]+')}$`);

// Writes that re-authenticate are online-only too. Their bodies carry the
// user's password, which a queued request would keep in IndexedDB, and the
// synthetic 202 would read as success: a password change the user saw succeed
// would land later, or an account deletion would sign them out while the
// account still exists and then delete it whenever the queue replays.
const isReauthenticatingWrite = (method: string, pathname: string): boolean =>
  (method === 'DELETE' && pathname === API_BASE_PATH + apiPaths.usersMe)
  || pathname === API_BASE_PATH + apiPaths.usersMePassword;

// Note images are immutable for a given ID — the ID is minted per upload and
// the bytes behind it never change — so cache-first is safe here in a way it is
// not for build assets. Registered ahead of the API route below, which would
// otherwise claim these URLs and re-fetch every image on every load.
//
// The bytes never change, but access to them can: a collaborator removed from
// a note would keep seeing its images from this cache without the server being
// asked. Sign-out deletes the cache; the expiry bounds how long a revoked image
// stays visible to someone who stays signed in.
const NOTE_IMAGE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

registerRoute(
  ({ url }) => /^\/api\/v1\/images\/[^/]+(\/thumbnail)?$/.test(url.pathname),
  new CacheFirst({
    cacheName: NOTE_IMAGES_CACHE,
    plugins: [
      {
        // Treat an expired copy as a miss, so CacheFirst refetches (and
        // re-caches) it. Judged by the response's Date header, as Workbox's
        // ExpirationPlugin does; a copy without one is kept.
        cachedResponseWillBeUsed: async ({ cachedResponse }) => {
          const date = Date.parse(cachedResponse?.headers.get('date') ?? '');
          if (cachedResponse && !Number.isNaN(date) && Date.now() - date > NOTE_IMAGE_MAX_AGE_SECONDS * 1000) {
            return null;
          }
          return cachedResponse;
        },
        // The server marks images `immutable` for a year, so a plain fetch
        // would be answered from the browser's HTTP cache — no access check,
        // and the old Date header would make the re-cached copy expire again
        // at once. Revalidating asks the server (a cheap 304 via the ETag) and
        // refreshes Date.
        requestWillFetch: async ({ request }) => new Request(request, { cache: 'no-cache' }),
        // Offline, an expired copy is still better than a broken image. Only a
        // network failure lands here; a 403 from the server is a response and
        // is passed through.
        handlerDidError: async ({ request }) => {
          const cache = await caches.open(NOTE_IMAGES_CACHE);
          return (await cache.match(request)) ?? undefined;
        },
      },
    ],
  })
);

// API caching strategy - Network First with offline fallback
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/api/v1/') && url.pathname !== SSE_PATH && !url.pathname.startsWith(PUBLIC_API_PREFIX),
  new NetworkFirst({
    cacheName: API_CACHE,
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

// Bumped each time sign-out empties the queue. A replay already under way
// checks it before re-queueing a failed request, so a request it took off the
// queue before the sign-out cannot be put back and sent for the next user.
let queueGeneration = 0;

const bgSyncQueue = new Queue('api-queue', {
  onSync: async ({ queue }) => {
    const generation = queueGeneration;
    let entry;
    while (generation === queueGeneration && (entry = await queue.shiftRequest())) {
      const retryCount = (entry.metadata as { retryCount?: number })?.retryCount || 0;
      
      try {
        await fetch(entry.request);
        // Success - don't re-add to queue
      } catch {
        if (retryCount < MAX_RETRY_COUNT) {
          // Add delay before retry and increment counter
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, retryCount)));
          if (generation !== queueGeneration) break;
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

// Sign-out (see removeUser in utils/auth.ts). A queued request carries no
// cookie of its own: replayed later, it would be sent with whoever is signed
// in by then, so a write user A made offline could land as user B. The session
// it belonged to is gone, so the queue is dropped rather than replayed.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: unknown } | null)?.type !== CLEAR_USER_DATA_MESSAGE) return;
  const reply = event.ports[0];
  event.waitUntil(
    (async () => {
      queueGeneration++;
      while (await bgSyncQueue.shiftRequest()) {
        // Dropped unsent.
      }
      await caches.delete(NOTE_IMAGES_CACHE);
      reply?.postMessage(null);
    })()
  );
});

// Serve every in-app route from the precached shell. Binding the handler to the
// precache (rather than caching navigation responses separately) is what keeps
// the HTML and the hashed assets it references on the same build: a deployment
// replaces both together, so a reload can never load a shell that asks for
// assets the server no longer has.
//
// Anything under /api/ is denied: /api/docs/index.html (Swagger UI) is a
// navigation the server owns, and handing it the SPA shell would replace it.
// Public note pages (/share/{token}) are denied too: the server answers them
// with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, which a
// shell served from the precache would not carry. The page needs the network
// for the note anyway, so going to it costs nothing offline.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, new RegExp(`^${PUBLIC_NOTE_PATH_PREFIX}`)],
  })
);

// Only POST endpoints that are idempotent or have uniqueness constraints are
// safe to retry via background sync. All other POSTs (e.g., note creation,
// import, duplicate, image upload) would create duplicates since the server
// generates a new random ID per request. Login is also excluded: answering it
// with a synthetic 202 would flip the client into an authenticated state with
// no user data. So is logout: a deferred logout reads as success while the
// session cookie (HttpOnly, so only the server's answer can clear it) stays in
// the browser, and replayed later it would end whichever session is current.
const retryablePostPaths = new Set([
  '/api/v1/notes/reorder',
]);

// POST paths with dynamic segments that are safe to retry. Each endpoint is
// matched exactly — a bare prefix like '/api/v1/notes/' would also capture
// non-idempotent endpoints (/notes/import, /notes/{id}/duplicate,
// /notes/{id}/images) that must never be replayed. Beyond idempotency, an
// endpoint only qualifies if its client ignores the response body: a queued
// request is answered with the synthetic 202 plain-text response below, which
// a body-reading caller would misparse (that rules out /notes/{id}/restore,
// /notes/{id}/labels and .../set-completed, whose clients read the
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
  if (PUBLIC_LINK_PATH.test(url.pathname)) return;
  if (isReauthenticatingWrite(request.method, url.pathname)) return;

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