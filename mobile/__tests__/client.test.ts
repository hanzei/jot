import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import {
  auth,
  getStoredSession,
  clearStoredSession,
  cacheAuthProfile,
  getCachedAuthProfile,
  clearCachedProfile,
  setServerUrl,
  switchActiveServer,
} from '../src/api/client';
import { getActiveServer, getServerScopedStorageKey } from '../src/store/serverAccounts';

jest.mock('axios', () => {
  const mockInstance = {
    post: jest.fn(),
    get: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
    defaults: { headers: { common: {} } },
  };
  const mockAxios = {
    create: jest.fn(() => mockInstance),
    __mockInstance: mockInstance,
  };
  return {
    __esModule: true,
    default: mockAxios,
    AxiosHeaders: jest.fn(),
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
  let serverId: string;

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
    serverId = active.serverId;
  });

  beforeEach(() => {
    jest.clearAllMocks();
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

  describe('auth.logout', () => {
    it('calls POST /logout and clears stored session and cached profile', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});

      await auth.logout();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/logout');
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_session$/));
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_cached_profile$/));
    });

    it('clears stored session and cached profile even when server call fails', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network Error'));

      await auth.logout();

      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_session$/));
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^jot_server_v1_.*_cached_profile$/));
    });
  });

  describe('auth.me', () => {
    it('calls GET /me and returns user data', async () => {
      const mockResponse = {
        data: { user: { id: '1', username: 'test' }, settings: { theme: 'system', note_sort: 'manual' } },
      };
      mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

      const result = await auth.me();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/me');
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
      memory.delete(getServerScopedStorageKey(serverId, 'session'));
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
      const requestInterceptor = requestUse.mock.calls[requestUse.mock.calls.length - 1]?.[0] as (
        config: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      const responseSuccessInterceptor = responseUse.mock.calls[responseUse.mock.calls.length - 1]?.[0] as (
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
});
