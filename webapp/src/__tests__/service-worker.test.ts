import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NavigationRoute } from 'workbox-routing';
import type { RouteMatchCallback, RouteMatchCallbackOptions } from 'workbox-core/types.js';

// The precache has no real backing store in a test, so those two are stubbed.
// workbox-routing is kept real (only registerRoute is intercepted) so the
// navigation route's denylist is exercised by Workbox's own matching logic
// rather than by a reimplementation of it.
const precacheAndRoute = vi.fn();
const createHandlerBoundToURL = vi.fn(() => appShellHandler);
const appShellHandler = { handle: vi.fn() };

vi.mock('workbox-precaching', () => ({
  precacheAndRoute,
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL,
}));

// A real Queue opens IndexedDB, which jsdom does not provide.
vi.mock('workbox-background-sync', () => ({
  Queue: class {
    pushRequest = vi.fn();
  },
}));

type RegisteredRoute = [RouteMatchCallback | NavigationRoute, unknown];
const registered: RegisteredRoute[] = [];

vi.mock('workbox-routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('workbox-routing')>();
  return {
    ...actual,
    registerRoute: vi.fn((...args: RegisteredRoute) => {
      registered.push(args);
    }),
  };
});

/** Build the argument Workbox passes to a route matcher. */
const context = (
  url: string,
  { destination = 'empty', mode = 'cors' } = {}
) => {
  const parsed = new URL(url, 'https://jot.example');
  return {
    url: parsed,
    request: { url: parsed.href, destination, mode, method: 'GET' } as unknown as Request,
    sameOrigin: true,
    event: {} as ExtendableEvent,
  } as unknown as RouteMatchCallbackOptions;
};

/** Route matchers registered with a callback, i.e. everything but the navigation route. */
const callbackRoutes = () =>
  registered
    .map(([matcher]) => matcher)
    .filter((matcher): matcher is RouteMatchCallback => typeof matcher === 'function');

const navigationRoute = () =>
  registered.map(([matcher]) => matcher).find((matcher) => typeof matcher !== 'function') as NavigationRoute;

const listeners = new Map<string, EventListener>();

describe('service worker', () => {
  beforeEach(async () => {
    registered.length = 0;
    listeners.clear();
    precacheAndRoute.mockClear();
    createHandlerBoundToURL.mockClear();
    vi.resetModules();

    vi.spyOn(self, 'addEventListener').mockImplementation(((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }) as typeof self.addEventListener);

    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
    vi.stubGlobal('skipWaiting', vi.fn());
    vi.stubGlobal('clients', { claim: vi.fn().mockResolvedValue(undefined) });

    await import('../service-worker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('build assets', () => {
    // The regression this guards: a runtime route that answers for hashed build
    // assets can serve a URL the current precache has never heard of. The server
    // falls back to index.html for unknown paths, so such a request resolves to
    // an HTML document with a 200 — which the browser then refuses to evaluate
    // as a module, leaving a white screen until the next manual reload.
    it.each([
      ['script', '/assets/index-BpJ4Fh05.js'],
      ['style', '/assets/index-CNJ8IrPN.css'],
    ])('leaves %s requests to the precache', (destination, path) => {
      const matched = callbackRoutes().filter((matcher) => matcher(context(path, { destination })));

      expect(matched).toHaveLength(0);
    });

    it('precaches the injected manifest', () => {
      expect(precacheAndRoute).toHaveBeenCalledTimes(1);
    });
  });

  describe('navigations', () => {
    it('serves in-app routes from the precached shell', () => {
      expect(createHandlerBoundToURL).toHaveBeenCalledWith('/index.html');
      expect(navigationRoute().handler).toBe(appShellHandler);
    });

    it.each(['/', '/login', '/notes/abc123'])('handles the %s navigation', (path) => {
      expect(navigationRoute().match(context(path, { mode: 'navigate' }))).toBeTruthy();
    });

    it('leaves server-owned pages alone', () => {
      // Swagger UI is served by the Go server; handing it the SPA shell would
      // replace the page with Jot.
      expect(navigationRoute().match(context('/api/docs/index.html', { mode: 'navigate' }))).toBeFalsy();
    });
  });

  describe('API routes', () => {
    it('caches note images ahead of the generic API route', () => {
      const [first] = callbackRoutes().filter((matcher) => matcher(context('/api/v1/images/abc123')));

      expect(first).toBe(callbackRoutes()[0]);
    });

    it.each(['/api/v1/images/abc123', '/api/v1/images/abc123/thumbnail'])('matches %s', (path) => {
      expect(callbackRoutes()[0]!(context(path))).toBeTruthy();
    });

    it('does not mistake other API paths for images', () => {
      expect(callbackRoutes()[0]!(context('/api/v1/notes/abc123/images'))).toBeFalsy();
    });

    it('never handles the SSE stream', () => {
      const matched = callbackRoutes().filter((matcher) => matcher(context('/api/v1/events')));

      expect(matched).toHaveLength(0);
    });
  });

  describe('activate', () => {
    it('drops the caches earlier revisions used for the shell and its assets', async () => {
      const waited: Promise<unknown>[] = [];
      listeners.get('activate')!({
        waitUntil: (promise: Promise<unknown>) => waited.push(promise),
      } as unknown as Event);
      await Promise.all(waited);

      expect(caches.delete).toHaveBeenCalledWith('navigations');
      expect(caches.delete).toHaveBeenCalledWith('static-assets');
    });
  });
});
