import axios, { AxiosHeaders, CanceledError, type InternalAxiosRequestConfig } from 'axios';
import { Platform } from 'react-native';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@jot/shared';
import { canonicalizeServerOrigin } from '@jot/shared';
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
    const response = await axios.get(`${canonical}/api/v1/me`, {
      timeout: 5000,
      headers: {
        'User-Agent': `JotMobile/1.0 (${platformLabel[Platform.OS] ?? Platform.OS})`,
      },
      validateStatus: () => true,
    });
    if (response.status === 200 || response.status === 401) {
      return { ok: true, canonicalUrl: canonical };
    }
    return { ok: false, reason: 'AUTH_ENDPOINT_UNAVAILABLE' };
  } catch {
    return { ok: false, reason: 'UNREACHABLE' };
  }
}

const api = axios.create({
  baseURL: `${currentBaseUrl}/api/v1`,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': `JotMobile/1.0 (${platformLabel[Platform.OS] ?? Platform.OS})`,
  },
});

function applyServerUrl(url: string): string {
  const normalized = canonicalizeServerOrigin(url);
  if (!normalized) {
    throw new Error(`Invalid server URL: ${url}`);
  }
  currentBaseUrl = normalized;
  api.defaults.baseURL = `${normalized}/api/v1`;
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

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const match = header.match(/jot_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
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

  let token = sessionCache;
  if (token === undefined) {
    token = await getStoredSession();
    sessionCache = token ?? null;
  }
  if (token) {
    if (!config.headers) {
      config.headers = new AxiosHeaders();
    }
    config.headers.set('Cookie', `jot_session=${token}`);
  }
  return config;
});

// On 401, clear stored session (handled by AuthContext for navigation)
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(cb: (() => void) | null): void {
  onUnauthorized = cb;
}

api.interceptors.response.use(
  (response) => {
    const config = response.config as SwitchAwareAxiosRequestConfig;
    releaseInflightController(config.__serverSwitchGenerationId, config.__serverSwitchAbortController);
    if (!isCurrentRequestGeneration(config.__serverSwitchGenerationId)) {
      throw new CanceledError('Discarded stale response after server switch.');
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

    if (error.response?.status === 401) {
      const url: string = config?.url || '';
      const isAuthEndpoint = url === '/login' || url === '/register' || url === '/logout' || url === '/me';
      if (!isAuthEndpoint) {
        await clearStoredSession();
        await clearCachedProfile();
        onUnauthorized?.();
      }
    }
    return Promise.reject(error);
  },
);

async function storeSessionFromResponse(headers: Record<string, string | string[] | undefined>): Promise<void> {
  const token = extractSessionCookie(headers['set-cookie']);
  if (!token) {
    return;
  }
  const serverId = await resolveActiveServerId();
  if (serverId) {
    await setServerStorageValue(serverId, SESSION_KEY, token);
    sessionCache = token;
  }
}

export async function cacheAuthProfile(response: AuthResponse): Promise<void> {
  try {
    const serverId = await resolveActiveServerId();
    if (!serverId) {
      return;
    }
    await setServerStorageValue(serverId, CACHED_PROFILE_KEY, JSON.stringify(response));
  } catch {
    // Best-effort: profile caching is not critical
  }
}

export async function getCachedAuthProfile(): Promise<AuthResponse | null> {
  try {
    const serverId = await resolveActiveServerId();
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

export const auth = {
  login: async (data: LoginRequest): Promise<AuthResponse> => {
    const res = await api.post('/login', data);
    await storeSessionFromResponse(res.headers as Record<string, string | string[] | undefined>);
    return res.data;
  },

  register: async (data: RegisterRequest): Promise<AuthResponse> => {
    const res = await api.post('/register', data);
    await storeSessionFromResponse(res.headers as Record<string, string | string[] | undefined>);
    return res.data;
  },

  logout: async (): Promise<void> => {
    try {
      await api.post('/logout');
    } catch {
      // Best-effort: always clear local session even if server call fails
    }
    await clearStoredSession();
    await clearCachedProfile();
  },

  me: async (): Promise<AuthResponse> => {
    const res = await api.get('/me');
    return res.data;
  },
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
  const token = await getServerStorageValue(serverId, SESSION_KEY);
  sessionCache = token ?? null;
  return sessionCache;
}

export async function clearStoredSession(): Promise<void> {
  const serverId = await resolveActiveServerId();
  if (!serverId) {
    sessionCache = null;
    return;
  }
  await deleteServerStorageValue(serverId, SESSION_KEY);
  sessionCache = null;
}

export async function initializeServerContext(): Promise<void> {
  await ensureServerContextReady();
}

export default api;
