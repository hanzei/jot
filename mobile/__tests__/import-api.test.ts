import axios from 'axios';
import { Platform } from 'react-native';
import { importFile } from '../src/api/notes';

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

describe('import API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = 'ios';
  });

  describe('importFile', () => {
    it('uploads multipart form data to POST /notes/import and returns import summary', async () => {
      const appendSpy = jest.spyOn(FormData.prototype, 'append');
      const summary = { imported: 2, skipped: 1 };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: summary });

      const result = await importFile({
        uri: 'file:///tmp/export.zip',
        name: 'export.zip',
        mimeType: 'application/zip',
      }, 'google_keep');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/notes/import',
        expect.any(FormData),
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      expect(appendSpy).toHaveBeenCalledWith(
        'file',
        expect.objectContaining({
          uri: '/tmp/export.zip',
          name: 'export.zip',
          type: 'application/zip',
        }),
      );
      expect(result).toEqual(summary);
      appendSpy.mockRestore();
    });

    it.each(['google_keep', 'jot_json'] as const)('sends import_type=%s, which the server requires', async (importType) => {
      const appendSpy = jest.spyOn(FormData.prototype, 'append');
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { imported: 1, skipped: 0 } });

      await importFile({
        uri: 'file:///tmp/export.zip',
        name: 'export.zip',
        mimeType: 'application/zip',
      }, importType);

      expect(appendSpy).toHaveBeenCalledWith('import_type', importType);
      appendSpy.mockRestore();
    });

    it('propagates axios errors from importFile', async () => {
      const expectedError = new Error('Network Error');
      mockAxiosInstance.post.mockRejectedValueOnce(expectedError);

      await expect(importFile({
        uri: 'file:///tmp/export.json',
        name: 'export.json',
        mimeType: 'application/json',
      }, 'google_keep')).rejects.toBe(expectedError);
    });

    it('keeps Android content URI in FormData and posts to /notes/import', async () => {
      const appendSpy = jest.spyOn(FormData.prototype, 'append');
      (Platform as { OS: string }).OS = 'android';
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { imported: 1, skipped: 0 } });

      await importFile({
        uri: 'content://com.android.providers.downloads.documents/document/123',
        name: 'export.json',
        mimeType: 'application/json',
      }, 'google_keep');

      expect(appendSpy).toHaveBeenCalledWith(
        'file',
        expect.objectContaining({
          uri: 'content://com.android.providers.downloads.documents/document/123',
          name: 'export.json',
          type: 'application/json',
        }),
      );
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/notes/import',
        expect.any(FormData),
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      appendSpy.mockRestore();
    });

    it('infers mime type when mimeType is omitted', async () => {
      const appendSpy = jest.spyOn(FormData.prototype, 'append');
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { imported: 1, skipped: 0 } });

      await importFile({
        uri: 'file:///tmp/keep-export.zip',
        name: 'keep-export.zip',
      }, 'google_keep');

      expect(appendSpy).toHaveBeenCalledWith(
        'file',
        expect.objectContaining({
          uri: '/tmp/keep-export.zip',
          name: 'keep-export.zip',
          type: 'application/zip',
        }),
      );
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/notes/import',
        expect.any(FormData),
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      appendSpy.mockRestore();
    });
  });
});
