import axios from 'axios';
import { getUsers, searchUsers, getNoteShares } from '../src/api/users';
import { getLabels } from '../src/api/labels';
import { listPATs } from '../src/api/settings';

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

const mockAxiosInstance = (axios as unknown as { __mockInstance: Record<'get' | 'post' | 'put' | 'patch' | 'delete', jest.Mock> })
  .__mockInstance;

// The server wraps every list in an object keyed by the resource name; the
// API layer unwraps it so callers keep receiving plain arrays.
describe('list endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getUsers unwraps users', async () => {
    const users = [{ id: 'u1', username: 'alice' }];
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { users, truncated: false } });

    await expect(getUsers()).resolves.toEqual(users);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users');
  });

  it('searchUsers unwraps users', async () => {
    const users = [{ id: 'u1', username: 'alice' }];
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { users, truncated: true } });

    await expect(searchUsers('ali')).resolves.toEqual(users);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users', { params: { search: 'ali' } });
  });

  it('getNoteShares unwraps shares', async () => {
    const shares = [{ id: 's1', note_id: 'n1', shared_with_user_id: 'u2' }];
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { shares } });

    await expect(getNoteShares('n1')).resolves.toEqual(shares);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes/n1/shares');
  });

  it('getLabels unwraps labels', async () => {
    const labels = [{ id: 'l1', name: 'work' }];
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { labels } });

    await expect(getLabels()).resolves.toEqual(labels);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/labels');
  });

  it('listPATs unwraps pats', async () => {
    const pats = [{ id: 'p1', name: 'CI', created_at: '2026-01-01T00:00:00Z' }];
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { pats } });

    await expect(listPATs()).resolves.toEqual(pats);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/pats');
  });
});
