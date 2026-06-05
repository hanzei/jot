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
  createNoteItem,
  updateNoteItem,
  deleteNoteItem,
  reorderNoteItems,
} from '../api/notes';
import { getNoteShares, shareNote, unshareNote } from '../api/users';
import type {
  Note,
  NoteShare,
  Label,
  GetNotesParams,
  CreateNoteRequest,
  UpdateNoteRequest,
  UpdateListNoteRequest,
  UpdateTextNoteRequest,
  CreateNoteItemRequest,
  PatchNoteItemRequest,
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
  createLocalItem,
  patchLocalItem,
  deleteLocalItem,
  reorderLocalItems,
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
      const labels: Label[] = [];
      const shared_with: NoteShare[] = [];
      const baseLocalNote = {
        id: localId,
        user_id: user?.id ?? '',
        color: data.color ?? '#ffffff',
        pinned: false,
        archived: false,
        position: 0,
        is_shared: false,
        deleted_at: null as string | null,
        created_at: now,
        updated_at: now,
        labels,
        shared_with,
      };
      const localNote: Note = data.note_type === 'list'
        ? {
            ...baseLocalNote,
            note_type: 'list',
            title: data.title,
            checked_items_collapsed: false,
            items: data.items?.map((item, i) => ({
              // Honor the client-supplied item ID so it stays stable when the
              // note create is replayed and items are later edited granularly.
              id: item.id ?? generateLocalId(),
              note_id: localId,
              text: item.text,
              completed: item.completed ?? false,
              position: i,
              indent_level: item.indent_level ?? 0,
              assigned_to: '',
              created_at: now,
              updated_at: now,
            })),
          }
        : {
            ...baseLocalNote,
            note_type: 'text',
            content: data.content,
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

      if (existing.note_type === 'list') {
        // List items are edited via the granular item mutations; this path only
        // carries scalar fields (title, pinned, archived, color, collapsed).
        const listData = data as UpdateListNoteRequest;
        await updateLocalNote(db, id, listData);

        const fullData: UpdateNoteRequest = {
          title: listData.title ?? existing.title,
          pinned: listData.pinned ?? existing.pinned,
          archived: listData.archived ?? existing.archived,
          color: listData.color ?? existing.color,
          checked_items_collapsed: listData.checked_items_collapsed ?? existing.checked_items_collapsed,
        };
        await enqueueOperation(db, {
          operation: 'update',
          endpoint: `/notes/${id}`,
          method: 'PATCH',
          body: fullData as Record<string, unknown>,
        });

        // Build optimistic return from the data we already have (no second DB read)
        return { ...existing, ...listData, updated_at: now };
      } else {
        const textData = data as UpdateTextNoteRequest;
        await updateLocalNote(db, id, textData);

        const fullData: UpdateNoteRequest = {
          content: textData.content ?? existing.content,
          pinned: textData.pinned ?? existing.pinned,
          archived: textData.archived ?? existing.archived,
          color: textData.color ?? existing.color,
        };
        await enqueueOperation(db, {
          operation: 'update',
          endpoint: `/notes/${id}`,
          method: 'PATCH',
          body: fullData as Record<string, unknown>,
        });

        // Build optimistic return from the data we already have (no second DB read)
        return { ...existing, ...textData, updated_at: now };
      }
    },
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(noteQueryKey(updatedNote.id), updatedNote);
      queryClient.setQueryData(noteLocalQueryKey(updatedNote.id), updatedNote);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

// --- Granular list-item mutations ----------------------------------------
// Editing list items one at a time (rather than re-sending the whole note)
// lets concurrent edits — including offline edits replayed later — merge with
// other devices' changes instead of overwriting them.

export function useCreateNoteItem() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, item }: { noteId: string; item: CreateNoteItemRequest }): Promise<void> => {
      assertSwitchWriteAllowed();
      const local = {
        id: item.id!,
        text: item.text,
        completed: item.completed ?? false,
        position: item.position,
        indent_level: item.indent_level ?? 0,
        assigned_to: item.assigned_to ?? '',
      };
      if (isConnectedRef.current) {
        await createNoteItem(noteId, item);
        await createLocalItem(db, noteId, local);
      } else {
        await createLocalItem(db, noteId, local);
        await enqueueOperation(db, {
          operation: 'createItem',
          endpoint: `/notes/${noteId}/items`,
          method: 'POST',
          body: item as unknown as Record<string, unknown>,
        });
      }
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

export function useUpdateNoteItem() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, itemId, data }: { noteId: string; itemId: string; data: PatchNoteItemRequest }): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isConnectedRef.current) {
        await updateNoteItem(noteId, itemId, data);
        await patchLocalItem(db, noteId, itemId, data);
      } else {
        await patchLocalItem(db, noteId, itemId, data);
        await enqueueOperation(db, {
          operation: 'updateItem',
          endpoint: `/notes/${noteId}/items/${itemId}`,
          method: 'PATCH',
          body: data as Record<string, unknown>,
        });
      }
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

export function useDeleteNoteItem() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, itemId }: { noteId: string; itemId: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isConnectedRef.current) {
        await deleteNoteItem(noteId, itemId);
        await deleteLocalItem(db, noteId, itemId);
      } else {
        await deleteLocalItem(db, noteId, itemId);
        await enqueueOperation(db, {
          operation: 'deleteItem',
          endpoint: `/notes/${noteId}/items/${itemId}`,
          method: 'DELETE',
        });
      }
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

export function useReorderNoteItems() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isConnectedRef.current) {
        await reorderNoteItems(noteId, itemIds);
        await reorderLocalItems(db, noteId, itemIds);
      } else {
        await reorderLocalItems(db, noteId, itemIds);
        await enqueueOperation(db, {
          operation: 'reorderItems',
          endpoint: `/notes/${noteId}/items/reorder`,
          method: 'POST',
          body: { item_ids: itemIds } as Record<string, unknown>,
        });
      }
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
