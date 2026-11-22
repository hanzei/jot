/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import type { RouteHandlerCallbackOptions, WorkboxPlugin } from 'workbox-core/types';
import { NetworkFirst, CacheFirst, type Strategy } from 'workbox-strategies';
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

// Bumped each time sign-out clears the user's data. Anything that started
// under an earlier generation belongs to the signed-out user: a replay stops,
// a failed write is not queued, and a response is not cached.
let userDataGeneration = 0;

// Queue writes and the sign-out drain run one at a time. A generation check
// alone is not enough: a pushRequest() that passed it could still commit
// after the drain had emptied the queue and acknowledged the sign-out.
let queueLock: Promise<unknown> = Promise.resolve();
const withQueueLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queueLock.then(fn);
  queueLock = run.catch(() => {});
  return run;
};

// The caches that hold a user's data, and the fetches whose write to one of
// them may still be pending. Sign-out deletes the caches once those settle,
// so none can be re-created with the previous user's data.
const USER_CACHES = [API_CACHE, NOTE_IMAGES_CACHE];
const pendingCacheWrites = new Set<Promise<unknown>>();

/** Caches only 200s, and only for a request made before the last sign-out. */
const userScopedCachePlugin: WorkboxPlugin = {
  requestWillFetch: async ({ request, state }) => {
    if (state) state.generation = userDataGeneration;
    return request;
  },
  cacheWillUpdate: async ({ response, state }) =>
    response.status === 200 && state?.generation === userDataGeneration ? response : null,
};

/** A route handler for `strategy` whose pending cache write sign-out can wait for. */
const trackingCacheWrites = (strategy: Strategy) => (options: RouteHandlerCallbackOptions) => {
  const [response, done] = strategy.handleAll(options);
  pendingCacheWrites.add(done);
  const forget = () => { pendingCacheWrites.delete(done); };
  done.then(forget, forget);
  return response;
};

// Note images are immutable for a given ID — the ID is minted per upload and
// the bytes behind it never change — so cache-first is safe here in a way it is
// not for build assets. Registered ahead of the API route below, which would
// otherwise claim these URLs and re-fetch every image on every load.
//
// The bytes never change, but access to them can: a collaborator removed from
// a note would keep seeing its images from this cache without the server being
// asked. Sign-out deletes the cache; the expiry bounds how long a revoked image
// stays visible to someone who stays signed in. Workbox's ExpirationPlugin is
// not used because it deletes expired copies, which are still worth showing
// offline.
const NOTE_IMAGE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

registerRoute(
  ({ url }) => /^\/api\/v1\/images\/[^/]+(\/thumbnail)?$/.test(url.pathname),
  trackingCacheWrites(new CacheFirst({
    cacheName: NOTE_IMAGES_CACHE,
    plugins: [
      userScopedCachePlugin,
      {
        // An expired copy (by its Date header) counts as a miss, so it is
        // fetched again; it is kept in `state` as the offline fallback.
        cachedResponseWillBeUsed: async ({ cachedResponse, state }) => {
          const date = Date.parse(cachedResponse?.headers.get('date') ?? '');
          if (cachedResponse && !Number.isNaN(date) && Date.now() - date > NOTE_IMAGE_MAX_AGE_SECONDS * 1000) {
            if (state) state.expired = cachedResponse;
            return null;
          }
          return cachedResponse;
        },
        // Images are served `immutable` for a year, so a plain fetch would be
        // answered from the HTTP cache without an access check (or a fresh
        // Date). Revalidating is a cheap 304 via the ETag.
        requestWillFetch: async ({ request }) => new Request(request, { cache: 'no-cache' }),
        // Only a network failure lands here; a 403 is a response and passes.
        handlerDidError: async ({ state }) => state?.expired as Response | undefined,
      },
    ],
  }))
);

// API caching strategy - Network First with offline fallback
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/api/v1/') && url.pathname !== SSE_PATH && !url.pathname.startsWith(PUBLIC_API_PREFIX),
  trackingCacheWrites(new NetworkFirst({
    cacheName: API_CACHE,
    networkTimeoutSeconds: 3,
    plugins: [
      userScopedCachePlugin,
      {
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
  }))
);

const LOGOUT_PATH = API_BASE_PATH + apiPaths.logout;

// Background sync for failed API requests with retry limits
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

const bgSyncQueue = new Queue('api-queue', {
  onSync: async ({ queue }) => {
    const generation = userDataGeneration;
    while (generation === userDataGeneration) {
      // Taken in turn with the sign-out drain, which queues for the lock as
      // soon as the sign-out arrives: a replay started after that finds the
      // queue empty, rather than taking an entry ahead of the drain.
      const entry = await withQueueLock(() => queue.shiftRequest());
      if (!entry) break;
      // A sign-out may have landed while the entry was being taken off the
      // queue; it belongs to the signed-out user, so drop it unsent.
      if (generation !== userDataGeneration) break;
      // Revisions before #1336 queued logouts. Replayed now, one would end
      // whichever session is current, so it is dropped unsent.
      if (new URL(entry.request.url).pathname === LOGOUT_PATH) continue;
      const retryCount = (entry.metadata as { retryCount?: number })?.retryCount || 0;

      try {
        await fetch(entry.request);
        // Success - don't re-add to queue
      } catch {
        if (retryCount < MAX_RETRY_COUNT) {
          // Add delay before retry and increment counter
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, retryCount)));
          const requeued = await withQueueLock(async () => {
            if (generation !== userDataGeneration) return false;
            await queue.unshiftRequest({
              ...entry,
              metadata: { retryCount: retryCount + 1 }
            });
            return true;
          });
          if (!requeued) break;
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
  // Bumped at once, not inside the lock: a write already holding the lock
  // commits before the drain below, and every later one sees the new value.
  userDataGeneration++;
  event.waitUntil(
    (async () => {
      try {
        await withQueueLock(async () => {
          while (await bgSyncQueue.shiftRequest()) {
            // Dropped unsent.
          }
        });
      } finally {
        // Even if the drain failed, the page is answered rather than left to
        // its timeout. The caches go now, and again once fetches started
        // before the sign-out have settled, in case one re-created them.
        await Promise.all(USER_CACHES.map((name) => caches.delete(name)));
        reply?.postMessage(null);
        await Promise.allSettled(pendingCacheWrites);
        await Promise.all(USER_CACHES.map((name) => caches.delete(name)));
      }
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
  const generation = userDataGeneration;
  event.respondWith(
    fetch(request.clone()).catch(async () => {
      const queued = await withQueueLock(async () => {
        // The user who made this request signed out while it was in flight.
        if (generation !== userDataGeneration) return false;
        await bgSyncQueue.pushRequest({ request });
        return true;
      });
      if (!queued) return Response.error();
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