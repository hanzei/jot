import axios from 'axios';
import { uploadNoteImage, NOTE_IMAGE_UPLOAD_TIMEOUT_MS } from '../src/api/images';

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

const mockImage = {
  id: 'img-1',
  filename: 'photo.png',
  content_type: 'image/png',
  width: 800,
  height: 600,
  created_at: '2024-01-01T00:00:00Z',
};

const file = { uri: 'file:///photos/photo.png', name: 'photo.png', mimeType: 'image/png' };

describe('uploadNoteImage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses a generous but finite timeout instead of disabling it (issue #695)', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mockImage });

    await uploadNoteImage('note-1', file);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/notes/note-1/images',
      expect.anything(),
      expect.objectContaining({ timeout: NOTE_IMAGE_UPLOAD_TIMEOUT_MS }),
    );
    expect(NOTE_IMAGE_UPLOAD_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('forwards a caller-provided abort signal so an in-flight upload can be cancelled', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mockImage });
    const controller = new AbortController();

    await uploadNoteImage('note-1', file, undefined, controller.signal);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/notes/note-1/images',
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('rejects with the underlying cancellation error when aborted', async () => {
    const cancelError = Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
    mockAxiosInstance.post.mockRejectedValueOnce(cancelError);

    await expect(uploadNoteImage('note-1', file)).rejects.toBe(cancelError);
  });
});
