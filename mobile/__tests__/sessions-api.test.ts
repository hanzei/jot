import axios from 'axios';
import { listSessions, revokeSession } from '../src/api/settings';

jest.mock('axios', () => {
  const mockInstance = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
    defaults: { headers: { common: {} } },
  };
  return {
    __esModule: true,
    default: { create: jest.fn(() => mockInstance), __mockInstance: mockInstance },
    AxiosHeaders: jest.fn(),
  };
});

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const mockAxiosInstance = (axios as unknown as { __mockInstance: Record<string, jest.Mock> })
  .__mockInstance;

describe('Sessions API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listSessions', () => {
    it('calls GET /sessions and returns the data', async () => {
      const mockSessions = [
        { id: 'abc123', browser: 'Chrome', os: 'Linux', is_current: true, created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-31T00:00:00Z' },
        { id: 'def456', browser: 'Safari', os: 'iOS', is_current: false, created_at: '2026-01-02T00:00:00Z', expires_at: '2026-02-01T00:00:00Z' },
      ];
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          items: mockSessions,
          pagination: { limit: 100, offset: 0, returned: mockSessions.length, has_more: false },
        },
      });

      const result = await listSessions();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/sessions', { params: { limit: 100, offset: 0 } });
      expect(result).toEqual(mockSessions);
    });

    it('fetches additional session pages when next_offset is present', async () => {
      const firstSession = [
        { id: 'abc123', browser: 'Chrome', os: 'Linux', is_current: true, created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-31T00:00:00Z' },
      ];
      const secondSession = [
        { id: 'def456', browser: 'Safari', os: 'iOS', is_current: false, created_at: '2026-01-02T00:00:00Z', expires_at: '2026-02-01T00:00:00Z' },
      ];
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: {
            items: firstSession,
            pagination: { limit: 100, offset: 0, returned: 1, has_more: true, next_offset: 1 },
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: secondSession,
            pagination: { limit: 100, offset: 1, returned: 1, has_more: false },
          },
        });

      const result = await listSessions();

      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(1, '/sessions', { params: { limit: 100, offset: 0 } });
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, '/sessions', { params: { limit: 100, offset: 1 } });
      expect(result).toEqual([...firstSession, ...secondSession]);
    });

    it('propagates errors', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('network error'));

      await expect(listSessions()).rejects.toThrow('network error');
    });
  });

  describe('revokeSession', () => {
    it('calls DELETE /sessions/:id', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});

      await revokeSession('abc123');

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/sessions/abc123');
    });

    it('propagates errors', async () => {
      mockAxiosInstance.delete.mockRejectedValueOnce(new Error('forbidden'));

      await expect(revokeSession('abc123')).rejects.toThrow('forbidden');
    });
  });
});
