import axios, { AxiosHeaders } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { AuthResponse, LoginRequest, RegisterRequest } from '../types';

const SESSION_KEY = 'jot_session';

// Default to localhost; override via environment or config for real devices.
const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:8080';

const api = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

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

export function setOnUnauthorized(cb: () => void): void {
  onUnauthorized = cb;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      const url: string = error.config?.url || '';
      const isAuthEndpoint = url === '/login' || url === '/register';
      if (!isAuthEndpoint) {
        await SecureStore.deleteItemAsync(SESSION_KEY);
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
    await api.post('/logout');
    await SecureStore.deleteItemAsync(SESSION_KEY);
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
