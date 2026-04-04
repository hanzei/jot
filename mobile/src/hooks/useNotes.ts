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
  duplicateNote,
  permanentDeleteNote,
  reorderNotes,
} from '../api/notes';
import { getNoteShares, shareNote, unshareNote } from '../api/users';
import type {
  Note,
  NoteShare,
  GetNotesParams,
  CreateNoteRequest,
  UpdateNoteRequest,
} from '@jot/shared';
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
import { isServerSwitchInProgress } from '../api/client';
import {
  noteLocalQueryKey,
  noteQueryKey,
  notesQueryKey,
  notesLocalQueryScopeKey,
  noteSharesQueryKey,
  notesQueryScopeKey,
} from './queryKeys';

function assertSwitchWriteAllowed(): void {
  if (isServerSwitchInProgress()) {
    throw new Error('Server switch in progress; write blocked');
  }
}

export function useNotes(params?: GetNotesParams) {
  return useQuery<Note[]>({
    queryKey: notesQueryKey(params),
    queryFn: () => getNotes(params),
  });
}

export function useNote(id: string | null) {
  return useQuery<Note>({
    queryKey: noteQueryKey(id),
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
      assertSwitchWriteAllowed();
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
          assigned_to: '',
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
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
      assertSwitchWriteAllowed();
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

      const fullData: UpdateNoteRequest = {
        title: data.title ?? existing.title,
        content: data.content ?? existing.content,
        pinned: data.pinned ?? existing.pinned,
        archived: data.archived ?? existing.archived,
        color: data.color ?? existing.color,
        checked_items_collapsed: data.checked_items_collapsed ?? existing.checked_items_collapsed,
        items: data.items,
      };
      await enqueueOperation(db, {
        operation: 'update',
        endpoint: `/notes/${id}`,
        method: 'PUT',
        body: fullData as Record<string, unknown>,
      });

      // Build optimistic return from the data we already have (no second DB read)
      return { ...existing, ...data, updated_at: now, items: updatedItems };
    },
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(noteQueryKey(updatedNote.id), updatedNote);
      queryClient.setQueryData(noteLocalQueryKey(updatedNote.id), updatedNote);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
      assertSwitchWriteAllowed();
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
      queryClient.removeQueries({ queryKey: noteQueryKey(id) });
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

export function useDuplicateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async (id: string): Promise<Note> => {
      assertSwitchWriteAllowed();
      if (!isConnectedRef.current) {
        throw new Error('Note duplication requires an internet connection');
      }

      const duplicatedNote = await duplicateNote(id);
      await saveNote(db, duplicatedNote);
      return duplicatedNote;
    },
    onSuccess: (duplicatedNote) => {
      queryClient.setQueryData(noteQueryKey(duplicatedNote.id), duplicatedNote);
      queryClient.setQueryData(noteLocalQueryKey(duplicatedNote.id), duplicatedNote);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
      assertSwitchWriteAllowed();
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
      queryClient.removeQueries({ queryKey: noteQueryKey(id) });
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
      assertSwitchWriteAllowed();
      if (isConnectedRef.current) {
        await permanentDeleteNote(id);
        await permanentDeleteLocalNote(db, id);
      } else {
        await permanentDeleteLocalNote(db, id);
        await enqueueOperation(db, {
          operation: 'permanentDelete',
          endpoint: `/notes/${id}?permanent=true`,
          method: 'DELETE',
        });
      }
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: noteQueryKey(id) });
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
      assertSwitchWriteAllowed();
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
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

export function useNoteShares(noteId: string | null) {
  return useQuery<NoteShare[]>({
    queryKey: noteSharesQueryKey(noteId),
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
      queryClient.invalidateQueries({ queryKey: noteSharesQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

export function useUnshareNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, userId }: { noteId: string; userId: string }) =>
      unshareNote(noteId, userId),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteSharesQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

// Re-export for convenience in screens that want explicit local-DB backed queries
export { saveNotes };
