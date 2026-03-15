import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import {
  getNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  restoreNote,
  permanentDeleteNote,
  reorderNotes,
} from '../api/notes';
import { getNoteShares, shareNote, unshareNote } from '../api/users';
import {
  Note,
  NoteShare,
  GetNotesParams,
  CreateNoteRequest,
  UpdateNoteRequest,
} from '../types';
import {
  saveNote,
  saveNotes,
  getLocalNote,
  markLocalNoteDeleted,
  markLocalNoteRestored,
  permanentDeleteLocalNote,
  updateLocalNote,
  generateLocalId,
} from '../db/noteQueries';
import { enqueueOperation } from '../db/syncQueue';
import { useNetworkStatus } from './useNetworkStatus';
import { useAuth } from '../store/AuthContext';

export function useNotes(params?: GetNotesParams) {
  return useQuery<Note[]>({
    queryKey: ['notes', params],
    queryFn: () => getNotes(params),
  });
}

export function useNote(id: string | null) {
  return useQuery<Note>({
    queryKey: ['note', id],
    queryFn: () => getNote(id!),
    enabled: id !== null,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: CreateNoteRequest): Promise<Note> => {
      if (isConnectedRef.current) {
        const note = await createNote(data);
        await saveNote(db, note);
        return note;
      }

      // Offline: create locally and queue the server operation
      const localId = generateLocalId();
      const now = new Date().toISOString();
      const localNote: Note = {
        id: localId,
        user_id: user?.id ?? '',
        title: data.title,
        content: data.content,
        note_type: data.note_type,
        color: data.color ?? '#ffffff',
        pinned: false,
        archived: false,
        position: 0,
        checked_items_collapsed: false,
        is_shared: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        labels: [],
        shared_with: [],
        items: data.items?.map((item, i) => ({
          id: generateLocalId(),
          note_id: localId,
          text: item.text,
          completed: item.completed ?? false,
          position: i,
          indent_level: item.indent_level ?? 0,
          assigned_to: item.assigned_to ?? '',
          created_at: now,
          updated_at: now,
        })),
      };
      await saveNote(db, localNote);
      await enqueueOperation(db, {
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: { local_id: localId, ...data } as Record<string, unknown>,
      });
      return localNote;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateNoteRequest }): Promise<Note> => {
      if (isConnectedRef.current) {
        const updatedNote = await updateNote(id, data);
        await saveNote(db, updatedNote);
        return updatedNote;
      }

      // Offline: update local DB and queue the server operation
      const existing = await getLocalNote(db, id);
      if (!existing) {
        throw new Error(`Note ${id} not found in local DB`);
      }
      const now = new Date().toISOString();
      let updatedItems = existing?.items;

      if (data.items !== undefined && existing) {
        // Persist item changes to note_items table alongside scalar field updates.
        // Preserve existing item IDs by position to avoid re-creating stable items.
        updatedItems = data.items.map((item, i) => ({
          id: existing.items?.[i]?.id ?? generateLocalId(),
          note_id: id,
          text: item.text,
          completed: item.completed ?? false,
          position: i,
          indent_level: item.indent_level ?? 0,
          assigned_to: item.assigned_to ?? existing.items?.[i]?.assigned_to ?? '',
          created_at: existing.items?.[i]?.created_at ?? now,
          updated_at: now,
        }));
        await saveNote(db, { ...existing, ...data, items: updatedItems, updated_at: now });
      } else {
        await updateLocalNote(db, id, data);
      }

      await enqueueOperation(db, {
        operation: 'update',
        endpoint: `/notes/${id}`,
        method: 'PUT',
        body: data as Record<string, unknown>,
      });

      // Build optimistic return from the data we already have (no second DB read)
      return { ...existing, ...data, updated_at: now, items: updatedItems };
    },
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(['note', updatedNote.id], updatedNote);
      queryClient.setQueryData(['note-local', updatedNote.id], updatedNote);
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (isConnectedRef.current) {
        await deleteNote(id);
        await markLocalNoteDeleted(db, id);
      } else {
        await markLocalNoteDeleted(db, id);
        await enqueueOperation(db, {
          operation: 'delete',
          endpoint: `/notes/${id}`,
          method: 'DELETE',
        });
      }
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['note', id] });
      queryClient.removeQueries({ queryKey: ['note-local', id] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useRestoreNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (isConnectedRef.current) {
        await restoreNote(id);
        await markLocalNoteRestored(db, id);
      } else {
        await markLocalNoteRestored(db, id);
        await enqueueOperation(db, {
          operation: 'restore',
          endpoint: `/notes/${id}/restore`,
          method: 'POST',
        });
      }
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['note', id] });
      queryClient.removeQueries({ queryKey: ['note-local', id] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function usePermanentDeleteNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (isConnectedRef.current) {
        await permanentDeleteNote(id);
        await permanentDeleteLocalNote(db, id);
      } else {
        await permanentDeleteLocalNote(db, id);
        await enqueueOperation(db, {
          operation: 'permanentDelete',
          endpoint: `/notes/${id}/permanent`,
          method: 'DELETE',
        });
      }
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['note', id] });
      queryClient.removeQueries({ queryKey: ['note-local', id] });
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useReorderNotes() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async (noteIds: string[]): Promise<void> => {
      if (isConnectedRef.current) {
        await reorderNotes(noteIds);
        // Update positions in local DB to match the new order
        for (let i = 0; i < noteIds.length; i++) {
          await updateLocalNote(db, noteIds[i], { position: i });
        }
      } else {
        // Update local positions to reflect the new order immediately, then enqueue
        for (let i = 0; i < noteIds.length; i++) {
          await updateLocalNote(db, noteIds[i], { position: i });
        }
        await enqueueOperation(db, {
          operation: 'reorder',
          endpoint: '/notes/reorder',
          method: 'POST',
          body: { note_ids: noteIds } as Record<string, unknown>,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes-local'] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useNoteShares(noteId: string | null) {
  return useQuery<NoteShare[]>({
    queryKey: ['noteShares', noteId],
    queryFn: () => getNoteShares(noteId!),
    enabled: noteId !== null,
  });
}

export function useShareNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, userId }: { noteId: string; userId: string }) =>
      shareNote(noteId, userId),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: ['noteShares', noteId] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

export function useUnshareNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, userId }: { noteId: string; userId: string }) =>
      unshareNote(noteId, userId),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: ['noteShares', noteId] });
      queryClient.invalidateQueries({ queryKey: ['note', noteId] });
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}

// Re-export for convenience in screens that want explicit local-DB backed queries
export { saveNotes };
