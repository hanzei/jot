import axios, { CanceledError } from 'axios';
import * as SecureStore from 'expo-secure-store';
import {
  auth,
  getStoredSession,
  clearStoredSession,
  setOnUnauthorized,
  cacheAuthProfile,
  getCachedAuthProfile,
  clearCachedProfile,
  setServerUrl,
  switchActiveServer,
  DEFAULT_REQUEST_TIMEOUT_MS,
  probeServerReachability,
  sessionCookieHeaders,
} from '../src/api/client';
import { getActiveServer, getServerScopedStorageKey } from '../src/store/serverAccounts';
import { isServerReachable, markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import { notesWrittenSince, snapshotMark } from '../src/db/snapshotGate';
import { apiErrorBody } from './helpers/apiError';

jest.mock('axios', () => {
  class MockCanceledError extends Error {
    code = 'ERR_CANCELED';
    __CANCEL__ = true;
    constructor(message?: string) {
      super(message);
      this.name = 'CanceledError';
    }
  }
  class MockAxiosError extends Error {
    static ERR_NETWORK = 'ERR_NETWORK';
    isAxiosError = true;
    code?: string | undefined;
    config?: unknown;
    request?: unknown;
    response?: unknown;
    constructor(message: string, errCode?: string, errConfig?: unknown, errRequest?: unknown) {
      super(message);
      this.name = 'AxiosError';
      this.code = errCode;
      this.config = errConfig;
      this.request = errRequest;
    }
  }
  const mockInstance = {
    post: jest.fn(),
    get: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
    defaults: { headers: { common: {} } },
  };
  const mockIsCancel = (value: unknown): boolean =>
    value instanceof MockCanceledError || Boolean((value as { __CANCEL__?: boolean })?.__CANCEL__);
  const mockAxios = {
    create: jest.fn(() => mockInstance),
    get: jest.fn(),
    __mockInstance: mockInstance,
    isCancel: mockIsCancel,
  };
  return {
    __esModule: true,
    default: mockAxios,
    AxiosHeaders: jest.fn(),
    AxiosError: MockAxiosError,
    CanceledError: MockCanceledError,
    isCancel: mockIsCancel,
  };
});

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

type MockAxiosInstance = {
  post: jest.Mock;
  get: jest.Mock;
  interceptors: {
    request: { use: jest.Mock };
    response: { use: jest.Mock };
  };
  defaults: { headers: { common: Record<string, unknown> } };
};

const mockAxiosInstance = (axios as unknown as { __mockInstance: MockAxiosInstance }).__mockInstance;

const mockSecureStore = SecureStore as unknown as {
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

describe('API Client', () => {
  const memory = new Map<string, string>();

  const getActiveTestServerId = async (): Promise<string> => {
    const active = await getActiveServer();
    if (!active) {
      throw new Error('missing active server');
    }
    return active.serverId;
  };

  beforeAll(async () => {
    mockSecureStore.getItemAsync.mockImplementation(async (key: string) => memory.get(key) ?? null);
    mockSecureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      memory.set(key, value);
    });
    mockSecureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      memory.delete(key);
    });
    await setServerUrl('https://test.example.com');
    const active = await getActiveServer();
    if (!active) {
      throw new Error('missing active server after setup');
    }
  });

  beforeEach(() => {
    mockAxiosInstance.post.mockClear();
    mockAxiosInstance.get.mockClear();
    mockSecureStore.getItemAsync.mockClear();
    mockSecureStore.setItemAsync.mockClear();
    mockSecureStore.deleteItemAsync.mockClear();
    mockSecureStore.getItemAsync.mockImplementation(async (key: string) => memory.get(key) ?? null);
    for (const key of Array.from(memory.keys())) {
      if (/^jot_server_v1_.*_(session|cached_profile)$/.test(key)) {
        memory.delete(key);
      }
    }
  });

  describe('auth.login', () => {
    it('calls POST /login and stores session from cookie', async () => {
      const mockResponse = {
        data: { user: { id: '1', username: 'test' }, settings: { theme: 'system', note_sort: 'manual' } },
        headers: { 'set-cookie': ['jot_session=abc123; Path=/; HttpOnly'] },
      };
      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await auth.login({ username: 'test', password: 'pass' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/login', {
        username: 'test',
        password: 'pass',
      });
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_session$/), 'abc123');
      expect(result).toEqual(mockResponse.data);
    });

    it('does not store session when set-cookie header is missing', async () => {
      const mockResponse = {
        data: { user: { id: '1', username: 'test' }, settings: { theme: 'system', note_sort: 'manual' } },
        headers: {},
      };
      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      await auth.login({ username: 'test', password: 'pass' });

      expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    it('throws on network error', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network Error'));

      await expect(auth.login({ username: 'test', password: 'pass' })).rejects.toThrow('Network Error');
    });
  });

  describe('auth.register', () => {
    it('calls POST /register and stores session from cookie', async () => {
      const mockResponse = {
        data: { user: { id: '2', username: 'newuser' }, settings: { theme: 'system', note_sort: 'manual' } },
        headers: { 'set-cookie': ['jot_session=def456; Path=/; HttpOnly'] },
      };
      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await auth.register({ username: 'newuser', password: 'pass' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/register', {
        username: 'newuser',
        password: 'pass',
      });
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_session$/), 'def456');
      expect(result).toEqual(mockResponse.data);
    });

    it('throws on network error', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network Error'));

      await expect(auth.register({ username: 'new', password: 'pass' })).rejects.toThrow('Network Error');
    });
  });

  describe('auth.oidcNativeExchange', () => {
    it('redeems the code and stores the session exactly like POST /login', async () => {
      const mockResponse = {
        data: { user: { id: '1', username: 'test' }, settings: { theme: 'system', note_sort: 'manual' } },
        headers: { 'set-cookie': ['jot_session=sso-token; Path=/; HttpOnly'] },
      };
      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await auth.oidcNativeExchange('one-time-code', 'the-verifier');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/auth/oidc/native/exchange', {
        code: 'one-time-code',
        code_verifier: 'the-verifier',
      });
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_session$/), 'sso-token');
      expect(await getStoredSession()).toBe('sso-token');
      expect(result).toEqual(mockResponse.data);
    });

    it('stores the session under the same key /login uses', async () => {
      const response = (token: string) => ({
        data: { user: { id: '1', username: 'test' }, settings: {} },
        headers: { 'set-cookie': [`jot_session=${token}; Path=/`] },
      });
      mockAxiosInstance.post.mockResolvedValueOnce(response('from-login'));
      await auth.login({ username: 'test', password: 'pass' });
      const loginKey = mockSecureStore.setItemAsync.mock.calls.at(-1)?.[0];

      mockAxiosInstance.post.mockResolvedValueOnce(response('from-sso'));
      await auth.oidcNativeExchange('code', 'verifier');
      const ssoKey = mockSecureStore.setItemAsync.mock.calls.find((call) => call[1] === 'from-sso')?.[0];

      expect(ssoKey).toBe(loginKey);
    });

    it('caches the profile under the server the exchange ran against', async () => {
      const serverId = await getActiveTestServerId();
      const data = { user: { id: '1', username: 'sso' }, settings: {} };
      mockAxiosInstance.post.mockResolvedValueOnce({ data, headers: { 'set-cookie': ['jot_session=t; Path=/'] } });

      await auth.oidcNativeExchange('code', 'verifier');

      expect(memory.get(getServerScopedStorageKey(serverId, 'cached_profile'))).toBe(JSON.stringify(data));
    });

    it('discards the result when the active server changes mid-exchange', async () => {
      await setServerUrl('https://sso-a.example.com');
      const serverA = await getActiveServer();
      await setServerUrl('https://sso-b.example.com');
      const serverB = await getActiveServer();
      if (!serverA || !serverB) {
        throw new Error('missing servers');
      }
      await switchActiveServer(serverA.serverId);
      mockAxiosInstance.post.mockImplementationOnce(async () => {
        // The user picks another server while the exchange is in flight.
        await switchActiveServer(serverB.serverId);
        return {
          data: { user: { id: 'a', username: 'from-a' }, settings: {} },
          headers: { 'set-cookie': ['jot_session=token-from-a; Path=/'] },
        };
      });

      const result = auth.oidcNativeExchange('code', 'verifier');

      await expect(result).rejects.toBeInstanceOf(CanceledError);
      for (const id of [serverA.serverId, serverB.serverId]) {
        expect(memory.has(getServerScopedStorageKey(id, 'session'))).toBe(false);
        expect(memory.has(getServerScopedStorageKey(id, 'cached_profile'))).toBe(false);
      }
      expect(await getStoredSession()).toBeNull();
    });

    it('propagates a 400 without storing anything', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({ response: { status: 400, data: apiErrorBody('validation_failed', 'invalid or expired code') } });

      await expect(auth.oidcNativeExchange('stale', 'verifier')).rejects.toEqual(
        expect.objectContaining({ response: expect.objectContaining({ status: 400 }) }),
      );
      expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    });
  });

  describe('auth.oidcNativeLink / auth.oidcUnlink', () => {
    it('posts the code and verifier to /auth/oidc/native/link', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ status: 204, data: '', headers: {} });

      await auth.oidcNativeLink('link-code', 'link-verifier');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/auth/oidc/native/link', {
        code: 'link-code',
        code_verifier: 'link-verifier',
      });
    });

    it('posts to /auth/oidc/unlink', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ status: 204, data: '', headers: {} });

      await auth.oidcUnlink();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/auth/oidc/unlink');
    });
  });

  describe('SSO requests and the 401 funnel', () => {
    const getResponseErrorHandler = () => {
      const responseUse = mockAxiosInstance.interceptors.response.use;
      return responseUse.mock.calls[0]?.[1] as (error: unknown) => Promise<unknown>;
    };

    // Signs in through the real /login path so the in-memory session cache
    // holds the token, as it does on device.
    const signInWithSession = async (token: string): Promise<string> => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { user: { id: '1', username: 'test' }, settings: {} },
        headers: { 'set-cookie': [`jot_session=${token}; Path=/`] },
      });
      await auth.login({ username: 'test', password: 'pass' });
      return getActiveTestServerId();
    };

    afterEach(() => {
      setOnUnauthorized(null);
    });

    it.each([
      ['/auth/oidc/native/exchange', 400],
      ['/auth/oidc/native/link', 400],
      ['/auth/oidc/native/link', 403],
      ['/auth/oidc/native/link', 409],
      ['/auth/oidc/unlink', 422],
    ])('a %s %i leaves the stored session alone', async (url, status) => {
      const serverId = await signInWithSession('still-valid');
      const onUnauthorized = jest.fn();
      setOnUnauthorized(onUnauthorized);

      await expect(getResponseErrorHandler()({ response: { status }, config: { url } })).rejects.toBeDefined();

      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(memory.get(getServerScopedStorageKey(serverId, 'session'))).toBe('still-valid');
    });

    it('a GET /users/me 401 does not expire the session, but a PATCH does', async () => {
      const serverId = await signInWithSession('still-valid');
      const onUnauthorized = jest.fn();
      setOnUnauthorized(onUnauthorized);

      await expect(
        getResponseErrorHandler()({ response: { status: 401 }, config: { url: '/users/me', method: 'get' } }),
      ).rejects.toBeDefined();
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(memory.get(getServerScopedStorageKey(serverId, 'session'))).toBe('still-valid');

      await expect(
        getResponseErrorHandler()({ response: { status: 401 }, config: { url: '/users/me', method: 'patch' } }),
      ).rejects.toBeDefined();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('a /auth/oidc/native/link 401 still means the session expired', async () => {
      const serverId = await signInWithSession('expired');
      const onUnauthorized = jest.fn();
      setOnUnauthorized(onUnauthorized);

      await expect(
        getResponseErrorHandler()({ response: { status: 401 }, config: { url: '/auth/oidc/native/link' } }),
      ).rejects.toBeDefined();

      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(memory.has(getServerScopedStorageKey(serverId, 'session'))).toBe(false);
    });
  });

  describe('failed request logging', () => {
    const getResponseErrorHandler = () => {
      const responseUse = mockAxiosInstance.interceptors.response.use;
      return responseUse.mock.calls[0]?.[1] as (error: unknown) => Promise<unknown>;
    };

    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it('logs a server error with the server request ID', async () => {
      await expect(getResponseErrorHandler()({
        response: { status: 500, headers: { 'x-request-id': 'abc123' } },
        config: { method: 'patch', url: '/notes/n1' },
      })).rejects.toBeDefined();

      expect(warn).toHaveBeenCalledWith('API PATCH /notes/n1 failed with 500 (request ID abc123)');
    });

    it('logs a server error without a request ID as none', async () => {
      await expect(getResponseErrorHandler()({
        response: { status: 502, headers: {} },
        config: { method: 'get', url: '/notes/n1' },
      })).rejects.toBeDefined();

      expect(warn).toHaveBeenCalledWith('API GET /notes/n1 failed with 502 (request ID none)');
    });

    it.each([
      ['a client error', { response: { status: 404, headers: { 'x-request-id': 'abc123' } } }],
      ['a request that got no response', { message: 'Network Error' }],
    ])('does not log %s', async (_label, error) => {
      await expect(getResponseErrorHandler()({ ...error, config: { method: 'get', url: '/notes' } })).rejects.toBeDefined();

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('auth.logout', () => {
    it('clears stored session and cached profile immediately, without waiting for POST /logout to resolve', async () => {
      await setServerUrl('https://logout-immediate.example.com');
      const serverId = await getActiveTestServerId();
      memory.set(getServerScopedStorageKey(serverId, 'session'), 'logout-token');

      let resolvePost!: (value: unknown) => void;
      mockAxiosInstance.post.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve; }));

      // The POST promise is left pending (never resolved) for the duration of
      // this test, yet auth.logout() must still resolve and clear local state.
      await auth.logout();

      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(getServerScopedStorageKey(serverId, 'session'));
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(getServerScopedStorageKey(serverId, 'cached_profile'));
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/logout', undefined, {
        headers: { Cookie: 'jot_session=logout-token' },
      });

      resolvePost({});
    });

    it('does not throw when the background POST /logout rejects', async () => {
      await setServerUrl('https://logout-reject.example.com');
      const serverId = await getActiveTestServerId();
      memory.set(getServerScopedStorageKey(serverId, 'session'), 'logout-token');
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network Error'));

      await expect(auth.logout()).resolves.toBeUndefined();

      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(getServerScopedStorageKey(serverId, 'session'));
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(getServerScopedStorageKey(serverId, 'cached_profile'));
    });

    it('skips the background network call when there is no stored session', async () => {
      await setServerUrl('https://logout-no-session.example.com');
      const serverId = await getActiveTestServerId();
      memory.delete(getServerScopedStorageKey(serverId, 'session'));

      mockAxiosInstance.post.mockClear();
      await auth.logout();

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(getServerScopedStorageKey(serverId, 'cached_profile'));
    });
  });

  describe('auth.me', () => {
    it('calls GET /me and returns user data', async () => {
      const mockResponse = {
        data: { user: { id: '1', username: 'test' }, settings: { theme: 'system', note_sort: 'manual' } },
      };
      mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

      const result = await auth.me();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users/me');
      expect(result).toEqual(mockResponse.data);
    });

    it('throws on network error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network Error'));

      await expect(auth.me()).rejects.toThrow('Network Error');
    });
  });

  describe('getStoredSession', () => {
    it('returns token from secure store', async () => {
      await setServerUrl('https://session-check.example.com');
      const sessionServerId = await getActiveTestServerId();
      memory.set(getServerScopedStorageKey(sessionServerId, 'session'), 'stored-token');
      const result = await getStoredSession();
      expect(result).toBe('stored-token');
    });

    it('returns null when no token stored', async () => {
      const activeServerId = await getActiveTestServerId();
      memory.delete(getServerScopedStorageKey(activeServerId, 'session'));
      await clearStoredSession();
      const result = await getStoredSession();
      expect(result).toBeNull();
    });
  });

  describe('clearStoredSession', () => {
    it('deletes token from secure store', async () => {
      await clearStoredSession();
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_session$/));
    });
  });

  describe('cacheAuthProfile', () => {
    it('stores profile as JSON in secure store', async () => {
      const profile = { user: { id: '1', username: 'test' }, settings: { theme: 'system', note_sort: 'manual' } };
      await cacheAuthProfile(profile as Parameters<typeof cacheAuthProfile>[0]);
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        expect.stringMatching(/^jot_server_v1_.*_cached_profile$/),
        JSON.stringify(profile),
      );
    });

    it('does not throw on SecureStore failure', async () => {
      mockSecureStore.setItemAsync.mockRejectedValueOnce(new Error('storage full'));
      await expect(
        cacheAuthProfile({ user: { id: '1' }, settings: {} } as Parameters<typeof cacheAuthProfile>[0]),
      ).resolves.toBeUndefined();
    });
  });

  describe('getCachedAuthProfile', () => {
    it('returns parsed profile from secure store', async () => {
      const profile = { user: { id: '1', username: 'test' }, settings: { theme: 'system', note_sort: 'manual' } };
      const activeServerId = await getActiveTestServerId();
      memory.set(getServerScopedStorageKey(activeServerId, 'cached_profile'), JSON.stringify(profile));
      const result = await getCachedAuthProfile();
      expect(result).toEqual(profile);
    });

    it('returns null when nothing cached', async () => {
      const activeServerId = await getActiveTestServerId();
      memory.delete(getServerScopedStorageKey(activeServerId, 'cached_profile'));
      const result = await getCachedAuthProfile();
      expect(result).toBeNull();
    });

    it('returns null on parse error', async () => {
      const activeServerId = await getActiveTestServerId();
      memory.set(getServerScopedStorageKey(activeServerId, 'cached_profile'), 'not-json');
      const result = await getCachedAuthProfile();
      expect(result).toBeNull();
    });
  });

  describe('clearCachedProfile', () => {
    it('deletes cached profile from secure store', async () => {
      await clearCachedProfile();
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_cached_profile$/));
    });
  });

  describe('switch lifecycle request guarding', () => {
    it('cancels in-flight old-generation requests when switching servers', async () => {
      await setServerUrl('https://switch-a.example.com');
      const firstServer = await getActiveServer();
      if (!firstServer) {
        throw new Error('missing first server');
      }

      await setServerUrl('https://switch-b.example.com');
      const secondServer = await getActiveServer();
      if (!secondServer) {
        throw new Error('missing second server');
      }

      const requestUse = mockAxiosInstance.interceptors.request.use;
      const responseUse = mockAxiosInstance.interceptors.response.use;
      if (requestUse.mock.calls.length !== 1 || responseUse.mock.calls.length !== 1) {
        throw new Error('Expected exactly one axios request and response interceptor registration');
      }
      const requestInterceptor = requestUse.mock.calls[0]?.[0] as (
        config: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      const responseSuccessInterceptor = responseUse.mock.calls[0]?.[0] as (
        response: { config: Record<string, unknown> },
      ) => { config: Record<string, unknown> };

      const staleConfig = await requestInterceptor({ method: 'get', headers: {} });

      await switchActiveServer(firstServer.serverId);
      const switched = await switchActiveServer(secondServer.serverId);
      expect(switched).toBe(true);

      expect((staleConfig.signal as AbortSignal).aborted).toBe(true);
      expect(() => responseSuccessInterceptor({ config: staleConfig })).toThrow('Discarded stale response after server switch.');
    });
  });

  describe('write landing record (#1265)', () => {
    it('records the notes a successful write touched, and nothing for a read', async () => {
      const responseUse = mockAxiosInstance.interceptors.response.use;
      const responseSuccessInterceptor = responseUse.mock.calls[0]?.[0] as (
        response: { config: Record<string, unknown> },
      ) => unknown;
      const mark = snapshotMark();

      responseSuccessInterceptor({ config: { method: 'patch', url: '/notes/n1', data: '{"content":"x"}' } });
      responseSuccessInterceptor({ config: { method: 'get', url: '/notes/n2' } });

      expect(notesWrittenSince(mark)).toEqual(new Set(['n1']));
    });
  });

  describe('responses that did not come from Jot (#1266)', () => {
    type Config = Record<string, unknown> & { headers: Record<string, string> };
    const getRequestInterceptor = () =>
      mockAxiosInstance.interceptors.request.use.mock.calls[0]?.[0] as (config: Record<string, unknown>) => Promise<Config>;
    const getResponseHandlers = () => {
      const call = mockAxiosInstance.interceptors.response.use.mock.calls[0];
      return {
        onSuccess: call?.[0] as (response: Record<string, unknown>) => unknown,
        onError: call?.[1] as (error: unknown) => Promise<unknown>,
      };
    };
    // A request config as the request interceptor leaves it.
    const sentConfig = (method: string, url: string, data?: string) =>
      getRequestInterceptor()({ method, url, data, headers: {}, timeout: DEFAULT_REQUEST_TIMEOUT_MS });
    const echo = (config: Config) => ({ 'x-request-id': config.headers['X-Request-Id'] });

    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      markServerReachable();
    });
    afterEach(() => {
      warn.mockRestore();
      setOnUnauthorized(null);
      markServerReachable();
    });

    it('sends a fresh request ID with every request', async () => {
      const first = await sentConfig('get', '/notes');
      const second = await sentConfig('get', '/notes');

      expect(first.headers['X-Request-Id']).toEqual(expect.any(String));
      expect(first.headers['X-Request-Id']).not.toBe(second.headers['X-Request-Id']);
    });

    it('accepts a response that echoes the request ID', async () => {
      const config = await sentConfig('patch', '/notes/jot1', '{"content":"x"}');
      const mark = snapshotMark();
      markServerUnreachable();
      const response = { status: 200, config, headers: echo(config) };

      expect(getResponseHandlers().onSuccess(response)).toBe(response);
      expect(isServerReachable()).toBe(true);
      expect(notesWrittenSince(mark)).toEqual(new Set(['jot1']));
    });

    it.each([
      ['no request ID', () => ({})],
      ['another request ID', () => ({ 'x-request-id': 'portal-id' })],
    ])('turns a 2xx carrying %s into a no-response error: unreachable, and the write not landed', async (_name, headers) => {
      const config = await sentConfig('patch', '/notes/portal1', '{"content":"x"}');
      const mark = snapshotMark();

      let thrown: unknown;
      try {
        getResponseHandlers().onSuccess({ status: 200, config, headers: headers(), data: '<html>Sign in</html>' });
      } catch (err) {
        thrown = err;
      }

      // The shape the sync queue reads as a transport failure: it keeps the entry.
      expect(thrown).toMatchObject({ isAxiosError: true, code: 'ERR_NETWORK' });
      expect((thrown as { response?: unknown }).response).toBeUndefined();
      expect(isServerReachable()).toBe(false);
      expect(notesWrittenSince(mark)).toEqual(new Set());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not echo the request ID'));
    });

    it('logs only when the server flips to unreachable, not for every portal response', async () => {
      for (let i = 0; i < 3; i++) {
        const config = await sentConfig('get', '/notes');
        expect(() => getResponseHandlers().onSuccess({ status: 200, config, headers: {} })).toThrow();
      }

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does not log the user out on a 401 that did not come from Jot', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { user: { id: '1', username: 'test' }, settings: {} },
        headers: { 'set-cookie': ['jot_session=kept; Path=/'] },
      });
      await auth.login({ username: 'test', password: 'pass' });
      const serverId = await getActiveTestServerId();
      const onUnauthorized = jest.fn();
      setOnUnauthorized(onUnauthorized);
      const config = await sentConfig('get', '/notes');

      const rejection = await getResponseHandlers().onError({ response: { status: 401, headers: {} }, config }).catch((err: unknown) => err);

      expect((rejection as { response?: unknown }).response).toBeUndefined();
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(memory.get(getServerScopedStorageKey(serverId, 'session'))).toBe('kept');
      expect(isServerReachable()).toBe(false);
    });

    it('still counts an error status from Jot as the server answering', async () => {
      const config = await sentConfig('get', '/notes');
      markServerUnreachable();

      const rejection = await getResponseHandlers().onError({
        response: { status: 500, headers: echo(config) },
        config,
      }).catch((err: unknown) => err);

      expect((rejection as { response?: { status: number } }).response?.status).toBe(500);
      expect(isServerReachable()).toBe(true);
    });
  });

  describe('probeServerReachability', () => {
    const mockGet = (axios as unknown as { get: jest.Mock }).get;
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it('accepts a Jot server, which echoes the request ID', async () => {
      mockGet.mockImplementationOnce(async (_url: string, opts: { headers: Record<string, string> }) => ({
        status: 401,
        headers: { 'x-request-id': opts.headers['X-Request-Id'] },
      }));

      await expect(probeServerReachability('http://192.168.1.10:8080')).resolves.toEqual({
        ok: true,
        canonicalUrl: 'http://192.168.1.10:8080',
      });
    });

    it('reports a captive portal 200 page as unreachable', async () => {
      mockGet.mockResolvedValueOnce({ status: 200, headers: {}, data: '<html>Sign in</html>' });

      await expect(probeServerReachability('http://192.168.1.10:8080')).resolves.toEqual({
        ok: false,
        reason: 'UNREACHABLE',
      });
    });
  });

  describe('request timeout', () => {
    const getRequestInterceptor = () => {
      const requestUse = mockAxiosInstance.interceptors.request.use;
      return requestUse.mock.calls[0]?.[0] as (
        config: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };

    // Every write with a local representation goes through the sync queue,
    // which sets its own timeout (#1285): a write the client makes directly
    // is a one-shot action with no queue, so it keeps the default.
    it.each(['get', 'post', 'patch', 'delete'])('keeps the configured timeout for a %s request', async (method) => {
      const config = await getRequestInterceptor()({
        method, url: '/notes', headers: {}, timeout: DEFAULT_REQUEST_TIMEOUT_MS,
      });
      expect(config.timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    });

    it('does not override an explicit per-request timeout', async () => {
      const config = await getRequestInterceptor()({
        method: 'post', url: '/notes', headers: {}, timeout: 60000,
      });
      expect(config.timeout).toBe(60000);
    });
  });

  describe('server-scoped auth/session isolation across two servers', () => {
    it('stores and reads session cookies independently per active server', async () => {
      await setServerUrl('https://isolation-a.example.com');
      const serverA = await getActiveServer();
      if (!serverA) {
        throw new Error('missing server A');
      }

      await setServerUrl('https://isolation-b.example.com');
      const serverB = await getActiveServer();
      if (!serverB) {
        throw new Error('missing server B');
      }

      mockAxiosInstance.post
        .mockResolvedValueOnce({
          data: { user: { id: 'a', username: 'usera' }, settings: { theme: 'system', note_sort: 'manual' } },
          headers: { 'set-cookie': ['jot_session=token-a; Path=/; HttpOnly'] },
        })
        .mockResolvedValueOnce({
          data: { user: { id: 'b', username: 'userb' }, settings: { theme: 'system', note_sort: 'manual' } },
          headers: { 'set-cookie': ['jot_session=token-b; Path=/; HttpOnly'] },
        });

      await switchActiveServer(serverA.serverId);
      await auth.login({ username: 'usera', password: 'pass' });

      await switchActiveServer(serverB.serverId);
      await auth.login({ username: 'userb', password: 'pass' });

      expect(memory.get(getServerScopedStorageKey(serverA.serverId, 'session'))).toBe('token-a');
      expect(memory.get(getServerScopedStorageKey(serverB.serverId, 'session'))).toBe('token-b');

      await switchActiveServer(serverA.serverId);
      expect(await getStoredSession()).toBe('token-a');

      await switchActiveServer(serverB.serverId);
      expect(await getStoredSession()).toBe('token-b');
    });
  });

  describe('sessionCookieHeaders', () => {
    const seedSessions = async () => {
      await setServerUrl('https://cookie-a.example.com');
      const serverA = await getActiveServer();
      await setServerUrl('https://cookie-b.example.com');
      const serverB = await getActiveServer();
      if (!serverA || !serverB) throw new Error('missing servers');
      memory.set(getServerScopedStorageKey(serverA.serverId, 'session'), 'token-a');
      memory.set(getServerScopedStorageKey(serverB.serverId, 'session'), 'token-b');
      return { serverA, serverB };
    };

    it("returns the active server's cookie for a URL on that server", async () => {
      const { serverA } = await seedSessions();
      await switchActiveServer(serverA.serverId);

      await expect(sessionCookieHeaders('https://cookie-a.example.com/api/v1/images/img-1'))
        .resolves.toEqual({ Cookie: 'jot_session=token-a' });
    });

    it('withholds the cookie from a URL built for a server that is no longer active', async () => {
      // A cache warm-up loop captured server A's URL, then the user switched to B.
      const { serverA, serverB } = await seedSessions();
      await switchActiveServer(serverA.serverId);
      const staleUrl = 'https://cookie-a.example.com/api/v1/users/u1/profile-icon';
      await expect(sessionCookieHeaders(staleUrl)).resolves.toEqual({ Cookie: 'jot_session=token-a' });

      await switchActiveServer(serverB.serverId);

      await expect(sessionCookieHeaders(staleUrl)).resolves.toEqual({});
    });

    it('withholds the cookie when the server switches while the session is read', async () => {
      const { serverA, serverB } = await seedSessions();
      await switchActiveServer(serverB.serverId);
      // Hold B's session read until the switch to A has finished.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockSecureStore.getItemAsync.mockImplementation(async (key: string) => {
        if (key === getServerScopedStorageKey(serverB.serverId, 'session')) await held;
        return memory.get(key) ?? null;
      });

      const headers = sessionCookieHeaders('https://cookie-a.example.com/api/v1/images/img-1');
      await switchActiveServer(serverA.serverId);
      release();

      // B's token must not go to A, although A is active by the time it is read.
      await expect(headers).resolves.toEqual({});
      // Nor may it stay cached as A's session for later requests.
      await expect(getStoredSession()).resolves.toBe('token-a');
    });

    it('returns no cookie when signed out', async () => {
      await setServerUrl('https://cookie-none.example.com');

      await expect(sessionCookieHeaders('https://cookie-none.example.com/api/v1/images/img-1')).resolves.toEqual({});
    });
  });

  describe('reachability belief reset on server switch', () => {
    afterEach(() => {
      // Reset to the default so state doesn't leak into other test files.
      markServerReachable();
    });

    it('resets an unreachable belief from a down server when switching to a healthy one', async () => {
      await setServerUrl('https://reachability-down.example.com');
      const serverA = await getActiveServer();
      if (!serverA) {
        throw new Error('missing server A');
      }
      await setServerUrl('https://reachability-healthy.example.com');
      const serverB = await getActiveServer();
      if (!serverB) {
        throw new Error('missing server B');
      }

      await switchActiveServer(serverA.serverId);
      markServerUnreachable();
      expect(isServerReachable()).toBe(false);

      await switchActiveServer(serverB.serverId);

      expect(isServerReachable()).toBe(true);
    });

    it('resets an unreachable belief picked up on the new server when switching back', async () => {
      await setServerUrl('https://reachability-a.example.com');
      const serverA = await getActiveServer();
      if (!serverA) {
        throw new Error('missing server A');
      }
      await setServerUrl('https://reachability-b.example.com');
      const serverB = await getActiveServer();
      if (!serverB) {
        throw new Error('missing server B');
      }

      await switchActiveServer(serverA.serverId);
      expect(isServerReachable()).toBe(true);

      await switchActiveServer(serverB.serverId);
      markServerUnreachable(); // simulate B turning out to be down
      expect(isServerReachable()).toBe(false);

      await switchActiveServer(serverA.serverId);

      // Switching back to A must not inherit B's stale "unreachable" verdict.
      expect(isServerReachable()).toBe(true);
    });
  });
});
