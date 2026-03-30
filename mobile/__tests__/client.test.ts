import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { auth, getStoredSession, clearStoredSession, cacheAuthProfile, getCachedAuthProfile, clearCachedProfile } from '../src/api/client';

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

const mockAxiosInstance = (axios as unknown as { __mockInstance: Record<string, jest.Mock> }).__mockInstance;

const mockSecureStore = SecureStore as unknown as {
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

describe('API Client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      mockSecureStore.getItemAsync.mockResolvedValueOnce('stored-token');
      const result = await getStoredSession();
      expect(result).toBe('stored-token');
    });

    it('returns null when no token stored', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce(null);
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
      mockSecureStore.getItemAsync.mockResolvedValueOnce(JSON.stringify(profile));
      const result = await getCachedAuthProfile();
      expect(result).toEqual(profile);
    });

    it('returns null when nothing cached', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce(null);
      const result = await getCachedAuthProfile();
      expect(result).toBeNull();
    });

    it('returns null on parse error', async () => {
      mockSecureStore.getItemAsync.mockResolvedValueOnce('not-json');
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
});
