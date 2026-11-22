import axios, { AxiosError, AxiosHeaders, CanceledError, type InternalAxiosRequestConfig } from 'axios';
import { Platform } from 'react-native';
import type { AuthResponse, LoginRequest, NativeExchangeRequest, RegisterRequest } from '@jot/shared';
import { apiPaths, apiRequestId, apiUrl, createJotApi, canonicalizeServerOrigin, isServerError } from '@jot/shared';
import { randomUUID } from '../utils/random';
import { isServerReachable, markServerReachable, markServerUnreachable } from './serverReachability';
import { REQUEST_ID_HEADER, echoesRequestId, newRequestId, warnNotJotResponse } from './jotResponse';
import { recordWriteResponse } from '../db/snapshotGate';
import { extractSessionCookie } from './sessionCookie';
import { assertSessionUsable } from './config';
import {
  addServer,
  ensureServerRegistryMigrated,
  getActiveServer,
  getServerStorageValue,
  setServerStorageValue,
  deleteServerStorageValue,
  switchServer as switchRegisteredServer,
  subscribeToActiveServerChanges,
} from '../store/serverAccounts';
import {
  beginServerSwitchLifecycle,
  abortServerSwitchLifecycle,
  clearServerSwitchLifecycleDegraded,
  completeServerSwitchLifecycle,
  getCurrentSwitchGenerationId,
  isServerSwitchInProgress as isServerSwitchInProgressInternal,
  markServerSwitchLifecycleDegraded,
  registerGenerationCancelHandler,
} from '../store/serverSwitchLifecycle';

const SESSION_KEY = 'session';
const CACHED_PROFILE_KEY = 'cached_profile';

function getDefaultBaseUrl(): string {
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:8080';
  }
  return 'http://localhost:8080';
}

let currentBaseUrl = process.env.EXPO_PUBLIC_API_URL || getDefaultBaseUrl();
let activeServerId: string | null = null;
let serverContextReady = false;
let serverContextInitPromise: Promise<void> | null = null;
let sessionCache: string | null | undefined;
type ActiveServerChangeListener = (serverId: string | null) => void;
const activeServerChangeListeners = new Set<ActiveServerChangeListener>();
const serverUrlById = new Map<string, string>();

export type ServerReachabilityResult =
  | { ok: true; canonicalUrl: string }
  | { ok: false; reason: 'INVALID_URL' | 'UNREACHABLE' | 'AUTH_ENDPOINT_UNAVAILABLE' };

interface SwitchAwareAxiosRequestConfig extends InternalAxiosRequestConfig {
  __serverSwitchGenerationId?: number;
  __serverSwitchAbortController?: AbortController;
  /** The `X-Request-Id` sent; Jot echoes it, anything else answering does not (#1266). */
  __jotRequestId?: string;
}

/**
 * Whether a response to `config` came from the Jot server. A config without a
 * recorded ID never went through the request interceptor (only tests build
 * those), so there is nothing to compare and it counts as Jot's.
 */
function isJotResponse(config: SwitchAwareAxiosRequestConfig | undefined, headers: unknown): boolean {
  const sentId = config?.__jotRequestId;
  return sentId === undefined || echoesRequestId(sentId, headers);
}

/**
 * Handle a response that did not come from Jot as if no response had arrived:
 * the server is marked unreachable and the caller gets an AxiosError without a
 * `response`, the shape every caller already treats as a transport failure. So
 * a captive portal's `200` page never counts as a landed write (the sync queue
 * keeps the entry) and a portal's `401` never logs the user out. Logged on the
 * flip only, so a portal does not flood the persisted log.
 */
function notJotResponseError(
  config: SwitchAwareAxiosRequestConfig | undefined,
  status: number | undefined,
  request: unknown,
): AxiosError {
  if (isServerReachable()) {
    warnNotJotResponse(`API ${(config?.method ?? 'get').toUpperCase()} ${config?.url ?? ''}`, status);
  }
  markServerUnreachable();
  return new AxiosError('Response did not come from the Jot server.', AxiosError.ERR_NETWORK, config, request);
}

const inflightControllersByGeneration = new Map<number, Set<AbortController>>();

export function getBaseUrl(): string {
  return currentBaseUrl;
}

export function getActiveServerId(): string | null {
  return activeServerId;
}

export function isServerSwitchInProgress(): boolean {
  return isServerSwitchInProgressInternal();
}

// Shared write guard: a mutation should never land mid-switch and get applied
// against (or persisted under) the wrong server.
export function assertSwitchWriteAllowed(): void {
  if (isServerSwitchInProgressInternal()) {
    throw new Error('Server switch in progress; write blocked');
  }
}

function notifyActiveServerChange(serverId: string | null): void {
  for (const listener of activeServerChangeListeners) {
    listener(serverId);
  }
}

export function subscribeToClientActiveServerChanges(listener: ActiveServerChangeListener): () => void {
  activeServerChangeListeners.add(listener);
  return () => {
    activeServerChangeListeners.delete(listener);
  };
}

function trackInflightController(generationId: number, controller: AbortController): void {
  const bucket = inflightControllersByGeneration.get(generationId);
  if (bucket) {
    bucket.add(controller);
    return;
  }
  inflightControllersByGeneration.set(generationId, new Set([controller]));
}

function releaseInflightController(generationId: number | undefined, controller: AbortController | undefined): void {
  if (generationId === undefined || !controller) {
    return;
  }
  const bucket = inflightControllersByGeneration.get(generationId);
  if (!bucket) {
    return;
  }
  bucket.delete(controller);
  if (bucket.size === 0) {
    inflightControllersByGeneration.delete(generationId);
  }
}

function cancelInflightControllersForGeneration(generationId: number): void {
  const bucket = inflightControllersByGeneration.get(generationId);
  if (!bucket) {
    return;
  }
  for (const controller of bucket) {
    controller.abort();
  }
  inflightControllersByGeneration.delete(generationId);
}

function isCurrentRequestGeneration(generationId: number | undefined): boolean {
  if (generationId === undefined) {
    return true;
  }
  return generationId === getCurrentSwitchGenerationId();
}

registerGenerationCancelHandler((generationId) => {
  cancelInflightControllersForGeneration(generationId);
});

async function applyActiveServerState(serverId: string | null): Promise<void> {
  if (!serverId) {
    activeServerId = null;
    sessionCache = undefined;
    notifyActiveServerChange(null);
    return;
  }

  let serverUrl = serverUrlById.get(serverId);
  if (!serverUrl) {
    const active = await getActiveServer();
    if (!active || active.serverId !== serverId) {
      activeServerId = null;
      sessionCache = undefined;
      notifyActiveServerChange(null);
      return;
    }
    serverUrl = active.serverUrl;
    serverUrlById.set(active.serverId, active.serverUrl);
  }

  applyServerUrl(serverUrl);
  activeServerId = serverId;
  sessionCache = undefined;
  notifyActiveServerChange(serverId);
}

export async function getStoredServerUrl(): Promise<string | null> {
  await ensureServerContextReady();
  const active = await getActiveServer();
  if (!active) {
    return null;
  }
  activeServerId = active.serverId;
  applyServerUrl(active.serverUrl);
  return active.serverUrl;
}

const platformLabel: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
  windows: 'Windows',
  macos: 'macOS',
};

export async function probeServerReachability(url: string): Promise<ServerReachabilityResult> {
  const canonical = canonicalizeServerOrigin(url);
  if (!canonical) {
    return { ok: false, reason: 'INVALID_URL' };
  }

  try {
    const requestId = newRequestId();
    const response = await axios.get(apiUrl(apiPaths.usersMe, canonical), {
      timeout: 5000,
      headers: {
        'User-Agent': `JotMobile/1.0 (${platformLabel[Platform.OS] ?? Platform.OS})`,
        [REQUEST_ID_HEADER]: requestId,
      },
      validateStatus: () => true,
    });
    // A captive portal answers 200 too; only Jot echoes the request ID (#1266).
    if (!echoesRequestId(requestId, response.headers)) {
      warnNotJotResponse('Server check', response.status);
      return { ok: false, reason: 'UNREACHABLE' };
    }
    if (response.status === 200 || response.status === 401) {
      return { ok: true, canonicalUrl: canonical };
    }
    return { ok: false, reason: 'AUTH_ENDPOINT_UNAVAILABLE' };
  } catch {
    return { ok: false, reason: 'UNREACHABLE' };
  }
}

// Unique ID for this app launch, used to suppress SSE echoes of our own mutations.
export const CLIENT_ID = randomUUID();

/**
 * Timeout for a request made outside the sync queue: reads, auth and the
 * one-shot actions with no queue (public links, empty trash, PATs). It can
 * legitimately take a while on a slow link, and nothing faster is waiting to
 * take over. Queued writes set their own (QUEUED_WRITE_TIMEOUT_MS in
 * db/syncQueue.ts) and uploads theirs.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

const api = axios.create({
  baseURL: apiUrl('', currentBaseUrl),
  timeout: DEFAULT_REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': `JotMobile/1.0 (${platformLabel[Platform.OS] ?? Platform.OS})`,
    'X-Client-Id': CLIENT_ID,
  },
});

function applyServerUrl(url: string): string {
  const normalized = canonicalizeServerOrigin(url);
  if (!normalized) {
    throw new Error(`Invalid server URL: ${url}`);
  }
  currentBaseUrl = normalized;
  api.defaults.baseURL = apiUrl('', normalized);
  return normalized;
}

async function ensureServerContextReady(): Promise<void> {
  if (serverContextReady) {
    return;
  }
  if (!serverContextInitPromise) {
    serverContextInitPromise = (async () => {
      await ensureServerRegistryMigrated();
      const active = await getActiveServer();
      if (active) {
        serverUrlById.set(active.serverId, active.serverUrl);
        await applyActiveServerState(active.serverId);
      }
      subscribeToActiveServerChanges((serverId) => {
        void applyActiveServerState(serverId);
      });
      serverContextReady = true;
    })();
  }
  try {
    await serverContextInitPromise;
  } finally {
    serverContextInitPromise = null;
  }
}

async function resolveActiveServerId(): Promise<string | null> {
  await ensureServerContextReady();
  if (activeServerId) {
    return activeServerId;
  }
  const active = await getActiveServer();
  if (!active) {
    return null;
  }
  serverUrlById.set(active.serverId, active.serverUrl);
  activeServerId = active.serverId;
  applyServerUrl(active.serverUrl);
  return active.serverId;
}

export async function switchActiveServer(serverId: string): Promise<boolean> {
  await ensureServerContextReady();
  const previousActiveServerId = activeServerId;
  if (previousActiveServerId === serverId) {
    return true;
  }

  const { previousGenerationId } = beginServerSwitchLifecycle();

  const failPreCommit = async (): Promise<boolean> => {
    if (previousActiveServerId) {
      await switchRegisteredServer(previousActiveServerId).catch(() => {});
      const previousActiveServer = await getActiveServer().catch(() => null);
      if (previousActiveServer) {
        activeServerId = previousActiveServer.serverId;
        applyServerUrl(previousActiveServer.serverUrl);
      }
    }
    abortServerSwitchLifecycle();
    return false;
  };

  try {
    const switched = await switchRegisteredServer(serverId);
    if (!switched) {
      return failPreCommit();
    }

    const active = await getActiveServer();
    if (!active) {
      markServerSwitchLifecycleDegraded('active_server_missing_after_switch');
      return true;
    }

    applyServerUrl(active.serverUrl);
    activeServerId = active.serverId;
    sessionCache = undefined;
    // The reachability belief is process-global, not per-server: reset it to
    // the optimistic default so a stale "unreachable" verdict from the
    // previous server doesn't fast-fail reads/writes against a healthy new
    // one, and a stale "reachable" verdict doesn't delay noticing a down one
    // any longer than the first real request (#715).
    markServerReachable();
    clearServerSwitchLifecycleDegraded();
    completeServerSwitchLifecycle();
    return true;
  } catch (error) {
    if (isServerSwitchInProgressInternal()) {
      abortServerSwitchLifecycle();
    }
    console.warn('Server switch failed before commit:', error);
    return false;
  } finally {
    // Ensure we never keep stale controllers for the previous generation.
    cancelInflightControllersForGeneration(previousGenerationId);
  }
}

async function activateServerUrl(url: string): Promise<string> {
  await ensureServerContextReady();
  const canonical = canonicalizeServerOrigin(url);
  if (!canonical) {
    throw new Error(`Invalid server URL: ${url}`);
  }

  const addResult = await addServer(canonical);
  if (!addResult.success && addResult.code !== 'DUPLICATE') {
    throw new Error(addResult.message);
  }
  const serverId = addResult.success ? addResult.serverId : addResult.existingServerId;
  if (!serverId) {
    throw new Error('Unable to determine server account ID.');
  }

  const switched = await switchActiveServer(serverId);
  if (!switched) {
    throw new Error('Unable to switch active server.');
  }
  const active = await getActiveServer();
  if (!active) {
    throw new Error('Unable to resolve active server.');
  }
  activeServerId = active.serverId;
  sessionCache = undefined;
  applyServerUrl(active.serverUrl);
  return active.serverUrl;
}

/** Updates the in-memory base URL without writing to storage (used on session restore). */
export function restoreServerUrl(url: string): void {
  const canonical = canonicalizeServerOrigin(url);
  if (!canonical) {
    throw new Error(`Invalid server URL: ${url}`);
  }
  // Clear activeServerId so auth requests during login do not reuse another
  // server's session cookie.
  activeServerId = null;
  sessionCache = undefined;
  applyServerUrl(canonical);
}

export async function setServerUrl(url: string): Promise<void> {
  await activateServerUrl(url);
}

/**
 * @deprecated Use `setServerUrl` as the primary API for activating a server URL.
 */
export async function ensureActiveServer(url: string): Promise<void> {
  await setServerUrl(url);
}

// Axios always passes AxiosHeaders to the request interceptor; the plain-object
// branch keeps hand-built configs (tests) working.
function setRequestHeader(config: InternalAxiosRequestConfig, name: string, value: string): void {
  if (!config.headers) {
    config.headers = new AxiosHeaders();
  }
  if (typeof config.headers.set === 'function') {
    config.headers.set(name, value);
  } else {
    (config.headers as Record<string, string>)[name] = value;
  }
}

// Attach stored session cookie to every request
api.interceptors.request.use(async (config) => {
  const method = (config.method || 'get').toUpperCase();
  if (isServerSwitchInProgressInternal() && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    throw new CanceledError('Server switch in progress; write request blocked.');
  }

  const switchAwareConfig = config as SwitchAwareAxiosRequestConfig;
  const generationId = getCurrentSwitchGenerationId();
  const controller = new AbortController();
  const existingSignal = config.signal;
  if (existingSignal) {
    if (existingSignal.aborted) {
      controller.abort();
    } else {
      existingSignal.addEventListener?.('abort', () => controller.abort(), { once: true });
    }
  }
  switchAwareConfig.signal = controller.signal;
  switchAwareConfig.__serverSwitchGenerationId = generationId;
  switchAwareConfig.__serverSwitchAbortController = controller;
  trackInflightController(generationId, controller);

  const requestId = newRequestId();
  setRequestHeader(config, REQUEST_ID_HEADER, requestId);
  switchAwareConfig.__jotRequestId = requestId;

  // getStoredSession fills the cache itself, and only for the server it read.
  const token = sessionCache !== undefined ? sessionCache : await getStoredSession();
  if (token) {
    setRequestHeader(config, 'Cookie', `jot_session=${token}`);
  }
  return config;
});

// On 401, clear stored session (handled by AuthContext for navigation)
let onUnauthorized: (() => void) | null = null;
let isHandlingUnauthorized = false;

export function setOnUnauthorized(cb: (() => void) | null): void {
  onUnauthorized = cb;
}

/**
 * Clear the stored session/cached profile and notify AuthContext, the same way
 * the response interceptor reacts to a 401. Exported so the SSE stream — which
 * bypasses axios and would otherwise sit in a silently signed-in state until the
 * next API call happens to 401 — can funnel its own 401 through this one
 * centralized logout path. The re-entrancy guard makes concurrent callers (an
 * API 401 and an SSE 401 racing on session expiry) collapse into a single logout.
 */
export async function handleUnauthorizedSession(): Promise<void> {
  if (isHandlingUnauthorized || sessionCache === null) {
    return;
  }
  isHandlingUnauthorized = true;
  sessionCache = null;
  try {
    // allSettled, not all: the storage cleanup is best-effort, but AuthContext
    // must be notified regardless. A rejected clearStoredSession must not skip
    // the logout (nor, from the SSE `void` call site, surface as an unhandled
    // rejection). sessionCache is already nulled above, so auth is effectively
    // cleared in-memory even if the persisted token/profile fails to delete.
    await Promise.allSettled([clearStoredSession(), clearCachedProfile()]);
    onUnauthorized?.();
  } finally {
    isHandlingUnauthorized = false;
  }
}

api.interceptors.response.use(
  (response) => {
    const config = response.config as SwitchAwareAxiosRequestConfig;
    releaseInflightController(config.__serverSwitchGenerationId, config.__serverSwitchAbortController);
    const fromJot = isJotResponse(config, response.headers);
    if (fromJot) {
      // The server answered, so it is reachable — clear any prior unreachable
      // belief so writes resume hitting the network instead of queueing.
      markServerReachable();
      // The write landed, even if the response is discarded below: a snapshot
      // fetched before now must not roll its notes back (#1265).
      recordWriteResponse(config.method, config.url, config.data);
    }
    if (!isCurrentRequestGeneration(config.__serverSwitchGenerationId)) {
      throw new CanceledError('Discarded stale response after server switch.');
    }
    if (!fromJot) {
      throw notJotResponseError(config, response.status, response.request);
    }
    return response;
  },
  async (error) => {
    const config = error?.config as SwitchAwareAxiosRequestConfig | undefined;
    releaseInflightController(config?.__serverSwitchGenerationId, config?.__serverSwitchAbortController);

    if (!isCurrentRequestGeneration(config?.__serverSwitchGenerationId)) {
      throw new CanceledError('Discarded stale error response after server switch.');
    }

    if (axios.isCancel(error) || error instanceof CanceledError) {
      return Promise.reject(error);
    }

    // Update the reachability belief: an HTTP error status still proves the
    // server answered, whereas the absence of a response (timeout / connection
    // refused / DNS failure) means it did not — flip to unreachable so later
    // writes skip the doomed network round-trip and queue immediately.
    if (error.response && !isJotResponse(config, error.response.headers)) {
      return Promise.reject(notJotResponseError(config, error.response.status, error.request));
    }

    if (error.response) {
      markServerReachable();
      // One line per server error, carrying the server's request ID, so the
      // persisted logs (and the shared diagnostics report) can be matched to
      // the server's log line and trace. 4xx responses are left out: most are
      // expected and handled (offline replay conflicts, gone targets), and
      // logging them would push the useful entries out of the bounded log.
      if (isServerError(error)) {
        const requestId = apiRequestId(error) ?? 'none';
        console.warn(`API ${(config?.method ?? 'get').toUpperCase()} ${config?.url ?? ''} failed with ${error.response.status} (request ID ${requestId})`);
      }
    } else {
      markServerUnreachable();
    }

    if (error.response?.status === 401) {
      const url: string = config?.url || '';
      // Only the read is exempt: PATCH /users/me must still clear a dead session.
      const isCurrentUserRead = url === apiPaths.usersMe && config?.method?.toLowerCase() === 'get';
      const isAuthEndpoint = url === apiPaths.login || url === apiPaths.register || url === apiPaths.logout || isCurrentUserRead;
      if (!isAuthEndpoint) {
        await handleUnauthorizedSession();
      }
    }
    return Promise.reject(error);
  },
);

/**
 * Stores the session a response from `origin` set. Throws
 * InsecureSessionCookieError, storing nothing, for a `Secure` cookie that
 * arrived over plain HTTP.
 */
async function storeSessionFromResponse(
  headers: Record<string, string | string[] | undefined>,
  origin: string,
  boundServerId?: string,
): Promise<void> {
  const token = extractSessionCookie(headers['set-cookie'], origin);
  if (!token) {
    return;
  }
  const serverId = boundServerId ?? await resolveActiveServerId();
  if (serverId) {
    await setServerStorageValue(serverId, SESSION_KEY, token);
    // The in-memory cache belongs to the active server only.
    if (serverId === activeServerId) {
      sessionCache = token;
    }
  }
}

/** Omit `boundServerId` to cache under the active server. */
export async function cacheAuthProfile(response: AuthResponse, boundServerId?: string): Promise<void> {
  try {
    const serverId = boundServerId ?? await resolveActiveServerId();
    if (!serverId) {
      return;
    }
    await setServerStorageValue(serverId, CACHED_PROFILE_KEY, JSON.stringify(response));
  } catch {
    // Best-effort: profile caching is not critical
  }
}

/**
 * The cached profile for `boundServerId`, or for the active server when omitted.
 * Bind it when the read must belong to a server captured earlier (#1264): an
 * unbound read after a server switch returns the new server's profile.
 */
export async function getCachedAuthProfile(boundServerId?: string): Promise<AuthResponse | null> {
  try {
    const serverId = boundServerId ?? await resolveActiveServerId();
    if (!serverId) {
      return null;
    }
    const raw = await getServerStorageValue(serverId, CACHED_PROFILE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthResponse;
  } catch {
    return null;
  }
}

export async function clearCachedProfile(): Promise<void> {
  try {
    const serverId = await resolveActiveServerId();
    if (!serverId) {
      return;
    }
    await deleteServerStorageValue(serverId, CACHED_PROFILE_KEY);
  } catch {
    // Best-effort
  }
}

/**
 * The login screen's server switcher stays usable while a sign-in waits on
 * assertSessionUsable. A switch in that wait must not send the credentials to
 * a server the check never looked at, so the attempt is dropped (#1337).
 */
function assertServerUnchanged(origin: string): void {
  if (currentBaseUrl !== origin) {
    throw new CanceledError('Active server changed during sign-in.');
  }
}

// The shared endpoints for the auth calls that don't read response headers.
// (`api/jot.ts` can't be imported here: it imports this module.)
const sharedAuth = createJotApi(api);

export const auth = {
  login: async (data: LoginRequest): Promise<AuthResponse> => {
    const origin = currentBaseUrl;
    await assertSessionUsable(origin);
    assertServerUnchanged(origin);
    const res = await api.post(apiPaths.login, data);
    await storeSessionFromResponse(res.headers as Record<string, string | string[] | undefined>, origin);
    return res.data;
  },

  register: async (data: RegisterRequest): Promise<AuthResponse> => {
    const origin = currentBaseUrl;
    await assertSessionUsable(origin);
    assertServerUnchanged(origin);
    const res = await api.post(apiPaths.register, data);
    await storeSessionFromResponse(res.headers as Record<string, string | string[] | undefined>, origin);
    return res.data;
  },

  /**
   * Redeems a native SSO hand-off code. The
   * server answers exactly like `POST /login`, so the session is captured the
   * same way. A bad, expired, or reused code (or a wrong verifier) is a 400.
   */
  //
  // Unlike `login`, the result is bound to the server the exchange started on:
  // the login screen's server switcher stays usable while it is in flight, so
  // the response is discarded (CanceledError) if the active server changed,
  // and the session and profile are stored under the captured server ID
  // rather than re-resolving the active one.
  oidcNativeExchange: async (code: string, codeVerifier: string): Promise<AuthResponse> => {
    const serverId = await resolveActiveServerId();
    if (!serverId) {
      throw new Error('No active server for the SSO exchange.');
    }
    const assertStillActive = () => {
      if (activeServerId !== serverId) {
        throw new CanceledError('Active server changed during the SSO exchange.');
      }
    };
    const origin = currentBaseUrl;
    const res = await api.post(apiPaths.oidcNativeExchange, { code, code_verifier: codeVerifier } satisfies NativeExchangeRequest);
    assertStillActive();
    await storeSessionFromResponse(res.headers as Record<string, string | string[] | undefined>, origin, serverId);
    await cacheAuthProfile(res.data, serverId);
    assertStillActive();
    return res.data;
  },

  /**
   * Binds the identity behind a link-intent hand-off code to the signed-in
   * user. 204 on success; 409 when the identity belongs to another account,
   * 403 when the server has local login disabled, 400 for a bad code.
   */
  oidcNativeLink: async (code: string, codeVerifier: string): Promise<void> => {
    await api.post(apiPaths.oidcNativeLink, { code, code_verifier: codeVerifier } satisfies NativeExchangeRequest);
  },

  /** Unbinds the SSO identity; the server refuses (422) when that would strand a password-less account. */
  oidcUnlink: (): Promise<void> => sharedAuth.sso.unlink(),

  logout: async (): Promise<void> => {
    // Server-side session invalidation is best-effort: the session still
    // expires on the server on its own, and the raw token only ever lived on
    // this device. Clear the local session immediately so callers can land on
    // the login screen without waiting on a network round-trip to a server
    // that may be unreachable, then fire POST /logout in the background
    // (issue #696). The token is captured before clearing (which nulls the
    // in-memory session cache the request interceptor reads) and attached
    // explicitly so the background request still authenticates.
    const token = await getStoredSession();
    await clearStoredSession();
    await clearCachedProfile();
    if (token) {
      void sharedAuth.auth.logout({ headers: { Cookie: `jot_session=${token}` } }).catch(() => {
        // Best-effort: local session is already cleared regardless of outcome.
      });
    }
  },

  me: (): Promise<AuthResponse> => sharedAuth.auth.me(),
};

export async function getStoredSession(): Promise<string | null> {
  if (sessionCache !== undefined) {
    return sessionCache;
  }
  const serverId = await resolveActiveServerId();
  if (!serverId) {
    sessionCache = null;
    return null;
  }
  const token = (await getServerStorageValue(serverId, SESSION_KEY)) ?? null;
  // A server switch during the read reset the cache for the new server; storing
  // this token would hand the old server's session to every later request.
  if (activeServerId === serverId) {
    sessionCache = token;
  }
  return token;
}

/**
 * The session cookie as an explicit header for a request to `url` that
 * bypasses the axios interceptor above (native file downloads). Android's
 * expo-file-system downloader uses a bare OkHttpClient with no cookie jar, so
 * without this the request is unauthenticated there.
 *
 * The cookie is the active server's, so it is only returned when `url` is on
 * that server and no server switch happened while it was read. A caller can
 * hold a URL built for a server that is no longer active (a cache warm-up loop
 * that outlives a switch), and must not send the new server's session to the
 * old one: it gets no cookie and the request fails as unauthenticated.
 * Empty when signed out.
 */
export async function sessionCookieHeaders(url: string): Promise<Record<string, string>> {
  const serverId = activeServerId;
  const generationId = getCurrentSwitchGenerationId();
  const token = await getStoredSession();
  if (!token) return {};
  if (activeServerId !== serverId || getCurrentSwitchGenerationId() !== generationId) return {};
  const target = canonicalizeServerOrigin(url);
  if (target === null || target !== canonicalizeServerOrigin(currentBaseUrl)) return {};
  return { Cookie: `jot_session=${token}` };
}

export async function clearStoredSession(): Promise<void> {
  sessionCache = null;
  const serverId = await resolveActiveServerId();
  if (!serverId) {
    return;
  }
  await deleteServerStorageValue(serverId, SESSION_KEY);
}

export async function initializeServerContext(): Promise<void> {
  await ensureServerContextReady();
}

export default api;
