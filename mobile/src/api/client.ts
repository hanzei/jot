import axios, { AxiosHeaders } from 'axios';
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
} from '../store/serverAccounts';

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
let sessionCache: string | null | undefined;

export function getBaseUrl(): string {
  return currentBaseUrl;
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
  await ensureServerRegistryMigrated();
  const active = await getActiveServer();
  if (active) {
    activeServerId = active.serverId;
    applyServerUrl(active.serverUrl);
  }
  serverContextReady = true;
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
  activeServerId = active.serverId;
  applyServerUrl(active.serverUrl);
  return active.serverId;
}

export async function switchActiveServer(serverId: string): Promise<boolean> {
  await ensureServerContextReady();
  const switched = await switchRegisteredServer(serverId);
  if (!switched) {
    return false;
  }
  const active = await getActiveServer();
  if (!active) {
    return false;
  }
  activeServerId = active.serverId;
  sessionCache = undefined;
  applyServerUrl(active.serverUrl);
  return true;
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

  const switched = await switchRegisteredServer(serverId);
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
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      const url: string = error.config?.url || '';
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
