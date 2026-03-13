import axios from 'axios';
import { reorderNotes } from '../src/api/notes';

jest.mock('axios', () => {
  const mockInstance = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
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

describe('reorderNotes API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls POST /notes/reorder with note_ids payload', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({});

    await reorderNotes(['id-1', 'id-2', 'id-3']);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith('/notes/reorder', {
      note_ids: ['id-1', 'id-2', 'id-3'],
    });
  });

  it('throws on network error', async () => {
    mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network Error'));

    await expect(reorderNotes(['id-1'])).rejects.toThrow('Network Error');
  });
});
