import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { auth, getStoredSession, clearStoredSession } from '../src/api/client';

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

// Get the mock instance that was created
const mockAxiosInstance = (axios as unknown as { create: jest.Mock }).create.mock.results[0]?.value ||
  (axios as unknown as { __mockInstance: Record<string, jest.Mock> }).__mockInstance;

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
        data: { user: { id: '1', username: 'test' }, settings: { theme: 'system' } },
        headers: { 'set-cookie': ['jot_session=abc123; Path=/; HttpOnly'] },
      };
      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await auth.login({ username: 'test', password: 'pass' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/login', {
        username: 'test',
        password: 'pass',
      });
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('jot_session', 'abc123');
      expect(result).toEqual(mockResponse.data);
    });
  });

  describe('auth.register', () => {
    it('calls POST /register and stores session from cookie', async () => {
      const mockResponse = {
        data: { user: { id: '2', username: 'newuser' }, settings: { theme: 'system' } },
        headers: { 'set-cookie': ['jot_session=def456; Path=/; HttpOnly'] },
      };
      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await auth.register({ username: 'newuser', password: 'pass' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/register', {
        username: 'newuser',
        password: 'pass',
      });
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('jot_session', 'def456');
      expect(result).toEqual(mockResponse.data);
    });
  });

  describe('auth.logout', () => {
    it('calls POST /logout and clears stored session', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});

      await auth.logout();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/logout');
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('jot_session');
    });
  });

  describe('auth.me', () => {
    it('calls GET /me and returns user data', async () => {
      const mockResponse = {
        data: { user: { id: '1', username: 'test' }, settings: { theme: 'system' } },
      };
      mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

      const result = await auth.me();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/me');
      expect(result).toEqual(mockResponse.data);
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
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('jot_session');
    });
  });
});
