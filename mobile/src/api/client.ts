import axios, { AxiosHeaders } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@jot/shared';

const SESSION_KEY = 'jot_session';
const SERVER_URL_KEY = 'jot_server_url';
const CACHED_PROFILE_KEY = 'jot_cached_profile';

function getDefaultBaseUrl(): string {
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:8080';
  }
  return 'http://localhost:8080';
}

let currentBaseUrl = process.env.EXPO_PUBLIC_API_URL || getDefaultBaseUrl();

export function getBaseUrl(): string {
  return currentBaseUrl;
}

export async function getStoredServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL_KEY);
}

const api = axios.create({
  baseURL: `${currentBaseUrl}/api/v1`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

function applyServerUrl(url: string): string {
  const normalized = url.replace(/\/+$/, '');
  currentBaseUrl = normalized;
  api.defaults.baseURL = `${normalized}/api/v1`;
  return normalized;
}

/** Updates the in-memory base URL without writing to storage (used on session restore). */
export function restoreServerUrl(url: string): void {
  applyServerUrl(url);
}

export async function setServerUrl(url: string): Promise<void> {
  const normalized = url.replace(/\/+$/, '');
  try {
    new URL(normalized);
  } catch {
    throw new Error(`Invalid server URL: ${normalized}`);
  }
  applyServerUrl(normalized);
  await SecureStore.setItemAsync(SERVER_URL_KEY, normalized);
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
  const token = await SecureStore.getItemAsync(SESSION_KEY);
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
        await SecureStore.deleteItemAsync(SESSION_KEY);
        await clearCachedProfile();
        onUnauthorized?.();
      }
    }
    return Promise.reject(error);
  },
);

async function storeSessionFromResponse(headers: Record<string, string | string[] | undefined>): Promise<void> {
  const token = extractSessionCookie(headers['set-cookie']);
  if (token) {
    await SecureStore.setItemAsync(SESSION_KEY, token);
  }
}

export async function cacheAuthProfile(response: AuthResponse): Promise<void> {
  try {
    await SecureStore.setItemAsync(CACHED_PROFILE_KEY, JSON.stringify(response));
  } catch {
    // Best-effort: profile caching is not critical
  }
}

export async function getCachedAuthProfile(): Promise<AuthResponse | null> {
  try {
    const raw = await SecureStore.getItemAsync(CACHED_PROFILE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthResponse;
  } catch {
    return null;
  }
}

export async function clearCachedProfile(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CACHED_PROFILE_KEY);
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
    await SecureStore.deleteItemAsync(SESSION_KEY);
    await clearCachedProfile();
  },

  me: async (): Promise<AuthResponse> => {
    const res = await api.get('/me');
    return res.data;
  },
};

export async function getStoredSession(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_KEY);
}

export async function clearStoredSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export default api;
