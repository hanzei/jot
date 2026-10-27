import axios from 'axios';
import { Platform } from 'react-native';
import {
  getNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  duplicateNote,
  convertNoteType,
  importFile,
  getNoteRevisions,
  getNoteRevision,
  restoreNoteRevision,
  RESTORE_REVISION_TIMEOUT_MS,
} from '../src/api/notes';

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

describe('Notes API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = 'ios';
  });

  describe('getNotes', () => {
    it('calls GET /notes with params and returns notes array', async () => {
      const mockNotes = [{ id: '1', title: 'Note 1' }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { notes: mockNotes } });

      const result = await getNotes({ archived: false });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes', {
        params: { archived: false },
      });
      expect(result).toEqual(mockNotes);
    });

    it('calls GET /notes without params when none provided', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

      await getNotes();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes', { params: undefined });
    });

    it('passes my_tasks param to GET /notes', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

      await getNotes({ my_tasks: true });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes', {
        params: { my_tasks: true },
      });
    });

    it('strips user_id from server request params', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

      await getNotes({ my_tasks: true, user_id: 'user-123' });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes', {
        params: { my_tasks: true },
      });

    });

    it('throws on network error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network Error'));

      await expect(getNotes()).rejects.toThrow('Network Error');
    });
  });

  describe('getNote', () => {
    it('calls GET /notes/{id} and returns the note', async () => {
      const mockNote = { id: '123', title: 'My Note' };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockNote });

      const result = await getNote('123');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes/123');
      expect(result).toEqual(mockNote);
    });
  });

  describe('createNote', () => {
    it('calls POST /notes with data and returns created note', async () => {
      const newNote = { title: 'New', content: 'Content', note_type: 'text' as const };
      const created = { id: 'abc', ...newNote };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: created });

      const result = await createNote(newNote);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/notes', newNote);
      expect(result).toEqual(created);
    });
  });

  describe('updateNote', () => {
    it('calls PATCH /notes/{id} with data and returns updated note', async () => {
      const updateData = { title: 'Updated Title' };
      const updated = { id: '123', title: 'Updated Title' };
      mockAxiosInstance.patch.mockResolvedValueOnce({ data: updated });

      const result = await updateNote('123', updateData);

      expect(mockAxiosInstance.patch).toHaveBeenCalledWith('/notes/123', updateData);
      expect(result).toEqual(updated);
    });
  });

  describe('deleteNote', () => {
    it('calls DELETE /notes/{id}', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});

      await deleteNote('123');

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/notes/123');
    });

    it('throws on network error', async () => {
      mockAxiosInstance.delete.mockRejectedValueOnce(new Error('Network Error'));

      await expect(deleteNote('123')).rejects.toThrow('Network Error');
    });
  });

  describe('duplicateNote', () => {
    it('calls POST /notes/{id}/duplicate and returns the duplicated note', async () => {
      const duplicated = { id: 'copy-123', title: 'Copy of Original' };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: duplicated });

      const result = await duplicateNote('123');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/notes/123/duplicate', undefined);
      expect(result).toEqual(duplicated);
    });
  });

  describe('convertNoteType', () => {
    it('calls POST /notes/{id}/convert with the precomputed data and returns the converted note', async () => {
      const data = { note_type: 'list' as const, base_version: 3, items: [{ text: 'a', position: 0, completed: false }] };
      const converted = { id: '123', note_type: 'list', title: '', items: data.items };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: converted });

      const result = await convertNoteType('123', data);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/notes/123/convert', data);
      expect(result).toEqual(converted);
    });
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

  describe('note revisions', () => {
    it('lists revisions from GET /notes/{id}/revisions', async () => {
      const revisions = [{ id: 'rev-1', note_id: 'n1' }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { revisions } });

      const result = await getNoteRevisions('n1');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes/n1/revisions');
      expect(result).toEqual(revisions);
    });

    it('gets one revision from GET /notes/{id}/revisions/{revision_id}', async () => {
      const revision = { id: 'rev-1', note_id: 'n1', content: 'older' };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: revision });

      const result = await getNoteRevision('n1', 'rev-1');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes/n1/revisions/rev-1');
      expect(result).toEqual(revision);
    });

    it('restores with base_version and a read-sized timeout', async () => {
      const note = { id: 'n1', content: 'older', version: 4 };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: note });

      const result = await restoreNoteRevision('n1', 'rev-1', { base_version: 3 });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/notes/n1/revisions/rev-1/restore',
        { base_version: 3 },
        { timeout: RESTORE_REVISION_TIMEOUT_MS },
      );
      expect(result).toEqual(note);
    });
  });
});
