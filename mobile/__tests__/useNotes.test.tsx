import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNotes, useNote, useCreateNote, useUpdateNote, useDeleteNote } from '../src/hooks/useNotes';
import * as notesApi from '../src/api/notes';

jest.mock('../src/api/notes');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useNotes hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('useNotes', () => {
    it('fetches and returns notes', async () => {
      const mockNotes = [{ id: '1', title: 'Note 1' }];
      mockNotesApi.getNotes.mockResolvedValueOnce(mockNotes as never);

      const { result } = renderHook(() => useNotes(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockNotes);
      expect(mockNotesApi.getNotes).toHaveBeenCalledWith(undefined);
    });

    it('passes params to getNotes', async () => {
      mockNotesApi.getNotes.mockResolvedValueOnce([] as never);

      const params = { archived: true };
      const { result } = renderHook(() => useNotes(params), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockNotesApi.getNotes).toHaveBeenCalledWith(params);
    });
  });

  describe('useNote', () => {
    it('fetches a single note by ID', async () => {
      const mockNote = { id: '123', title: 'My Note' };
      mockNotesApi.getNote.mockResolvedValueOnce(mockNote as never);

      const { result } = renderHook(() => useNote('123'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockNote);
      expect(mockNotesApi.getNote).toHaveBeenCalledWith('123');
    });

    it('does not fetch when id is null', () => {
      const { result } = renderHook(() => useNote(null), { wrapper: createWrapper() });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockNotesApi.getNote).not.toHaveBeenCalled();
    });
  });

  describe('useCreateNote', () => {
    it('creates a note and returns it', async () => {
      const newNote = { id: 'new', title: 'Created' };
      mockNotesApi.createNote.mockResolvedValueOnce(newNote as never);

      const { result } = renderHook(() => useCreateNote(), { wrapper: createWrapper() });

      result.current.mutate({ title: 'Created', content: '', note_type: 'text' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(newNote);
    });
  });

  describe('useUpdateNote', () => {
    it('updates a note and returns updated data', async () => {
      const updated = { id: '123', title: 'Updated' };
      mockNotesApi.updateNote.mockResolvedValueOnce(updated as never);

      const { result } = renderHook(() => useUpdateNote(), { wrapper: createWrapper() });

      result.current.mutate({ id: '123', data: { title: 'Updated' } });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(updated);
      expect(mockNotesApi.updateNote).toHaveBeenCalledWith('123', { title: 'Updated' });
    });
  });

  describe('useDeleteNote', () => {
    it('deletes a note', async () => {
      mockNotesApi.deleteNote.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDeleteNote(), { wrapper: createWrapper() });

      result.current.mutate('123');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockNotesApi.deleteNote).toHaveBeenCalledWith('123');
    });
  });
});
