import axios from 'axios';
import { getNotes, getNote, createNote, updateNote, deleteNote, duplicateNote } from '../src/api/notes';

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

describe('Notes API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getNotes', () => {
    it('calls GET /notes with params and returns notes array', async () => {
      const mockNotes = [{ id: '1', title: 'Note 1' }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockNotes });

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

    it('passes my_todo param to GET /notes', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

      await getNotes({ my_todo: true });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes', {
        params: { my_todo: true },
      });
    });

    it('strips user_id from server request params', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

      await getNotes({ my_todo: true, user_id: 'user-123' });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/notes', {
        params: { my_todo: true },
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

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/notes/123/duplicate');
      expect(result).toEqual(duplicated);
    });
  });
});
