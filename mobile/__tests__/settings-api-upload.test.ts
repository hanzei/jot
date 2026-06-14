import axios from 'axios';
import { uploadProfileIcon, UPLOAD_ICON_TIMEOUT } from '../src/api/settings';

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

const mockUser = {
  id: 'user1',
  username: 'testuser',
  first_name: 'Test',
  last_name: 'User',
  role: 'user',
  has_profile_icon: true,
  updated_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
};

describe('uploadProfileIcon', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses UPLOAD_ICON_TIMEOUT instead of the default 15 s timeout', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mockUser });

    await uploadProfileIcon('file:///photos/avatar.jpg');

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/users/me/profile-icon',
      expect.anything(),
      expect.objectContaining({ timeout: UPLOAD_ICON_TIMEOUT }),
    );
    expect(UPLOAD_ICON_TIMEOUT).toBe(0);
  });

  it('strips file:// prefix on iOS', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mockUser });

    await uploadProfileIcon('file:///photos/avatar.jpg');

    const [key, fileValue] = appendSpy.mock.calls[0];
    expect(key).toBe('file');
    expect((fileValue as { uri: string }).uri).not.toContain('file://');
    appendSpy.mockRestore();
  });

  it('calls onUploadProgress with computed percentage', async () => {
    mockAxiosInstance.post.mockImplementationOnce(
      async (_url: string, _data: unknown, config: { onUploadProgress?: (e: { loaded: number; total: number }) => void }) => {
        config.onUploadProgress?.({ loaded: 60, total: 100 });
        return { data: mockUser };
      },
    );

    const onProgress = jest.fn();
    await uploadProfileIcon('file:///photos/avatar.jpg', onProgress);

    expect(onProgress).toHaveBeenCalledWith(60);
  });

  it('calls onUploadProgress with 0 when total is unknown', async () => {
    mockAxiosInstance.post.mockImplementationOnce(
      async (_url: string, _data: unknown, config: { onUploadProgress?: (e: { loaded: number; total?: number }) => void }) => {
        config.onUploadProgress?.({ loaded: 50 });
        return { data: mockUser };
      },
    );

    const onProgress = jest.fn();
    await uploadProfileIcon('file:///photos/avatar.jpg', onProgress);

    expect(onProgress).toHaveBeenCalledWith(0);
  });

  it('omits onUploadProgress from the request config when no callback is provided', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mockUser });

    await uploadProfileIcon('file:///photos/avatar.jpg');

    const config = mockAxiosInstance.post.mock.calls[0][2] as Record<string, unknown>;
    expect(config).not.toHaveProperty('onUploadProgress');
  });

  it('returns the updated user', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mockUser });

    const result = await uploadProfileIcon('file:///photos/avatar.jpg');

    expect(result).toEqual(mockUser);
  });

  it('propagates errors', async () => {
    mockAxiosInstance.post.mockRejectedValueOnce(new Error('network error'));

    await expect(uploadProfileIcon('file:///photos/avatar.jpg')).rejects.toThrow('network error');
  });
});
