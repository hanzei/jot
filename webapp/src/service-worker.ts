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
          // Create cache key without query parameters for GET requests
          if (request.method === 'GET') {
            const url = new URL(request.url);
            url.search = '';
            return url.toString();
          }
          return request.url;
        },
      },
    ],
  })
);

// Background sync for failed API requests
const bgSyncQueue = new Queue('api-queue', {
  onSync: async ({ queue }) => {
    let entry;
    while ((entry = await queue.shiftRequest())) {
      try {
        await fetch(entry.request);
        console.log('Background sync successful for:', entry.request.url);
      } catch (error) {
        console.error('Background sync failed for:', entry.request.url, error);
        // Re-add to queue if failed
        await queue.unshiftRequest(entry);
        break;
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

// Listen for messages from the client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Background sync route for non-GET API requests
registerRoute(
  ({ request, url }) => 
    request.method !== 'GET' && url.pathname.startsWith('/api/v1/'),
  async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      // If network request fails, add to background sync queue
      await bgSyncQueue.pushRequest({ request });
      // Return a response indicating the request was queued
      return new Response('Request queued for background sync', {
        status: 202,
        statusText: 'Accepted'
      });
    }
  }
);

// Handle install event
self.addEventListener('install', (event) => {
  console.log('Service worker installing...');
  event.waitUntil(self.skipWaiting());
});

// Handle activate event
self.addEventListener('activate', (event) => {
  console.log('Service worker activating...');
  event.waitUntil(self.clients.claim());
});