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
  toggleItemCompleted,
} from '../api/notes';
import { shareNote, unshareNote } from '../api/users';
import { useOfflineNote } from './useOfflineNotes';
import { generateId } from '@jot/shared';
import type {
  Note,
  NoteItem,
  NoteShare,
  User,
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
  isLocalId,
  createLocalItem,
  patchLocalItem,
  deleteLocalItem,
  reorderLocalItems,
} from '../db/noteQueries';
import type { LocalItemPatch } from '../db/noteQueries';
import { enqueueOperation, rethrowIfNotQueueable } from '../db/syncQueue';
import { useNetworkStatus } from './useNetworkStatus';
import { useAuth } from '../store/AuthContext';
import { isServerSwitchInProgress } from '../api/client';
import {
  noteLocalQueryKey,
  noteQueryKey,
  notesQueryKey,
  notesLocalQueryScopeKey,
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
        try {
          const note = await createNote(data);
          await saveNote(db, note);
          return note;
        } catch (err) {
          // Transient failure: fall through to the offline path so the new note
          // is persisted locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): create locally and queue the
      // server operation.
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
            items: (() => {
              let lastTopLevelId: string | null = null;
              return data.items?.map((item, i) => {
                // Honor the client-supplied item ID so it stays stable when the
                // note create is replayed and items are later edited granularly.
                const id = item.id ?? generateLocalId();
                const isChild = (item.indent_level ?? 0) === 1;
                const parentId = isChild ? lastTopLevelId : null;
                if (!isChild) lastTopLevelId = id;
                return {
                  id,
                  note_id: localId,
                  text: item.text,
                  completed: item.completed ?? false,
                  position: i,
                  parent_id: parentId,
                  assigned_to: '',
                  created_at: now,
                  updated_at: now,
                };
              });
            })(),
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
        try {
          const updatedNote = await updateNote(id, data);
          await saveNote(db, updatedNote);
          return updatedNote;
        } catch (err) {
          // Transient failure: fall through to the offline path so the edit is
          // persisted locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): update local DB and queue the
      // server operation.
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
      // Synchronously patch the note in every cached notes-list so the dashboard
      // shows fresh content immediately on navigation back, without waiting for
      // the async SQLite refetch that invalidateQueries schedules below.
      queryClient.setQueriesData<Note[]>(
        { queryKey: notesLocalQueryScopeKey() },
        (old) => old?.map((n) => (n.id === updatedNote.id ? updatedNote : n)),
      );
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
      // Ensure a stable, server-format ID up front so the local row, the server
      // request, and any queued op all reference the same item (the SQLite
      // insert must never receive an undefined id). This id is also what makes a
      // queued replay idempotent: if a transient failure hides a create the
      // server actually committed, replaying it POSTs the same id, the server
      // rejects the duplicate with 409 (ErrNoteItemExists), and drainQueue
      // dead-letters that 409 instead of creating a second item.
      const itemId: string = item.id ?? generateId();
      const itemWithId: CreateNoteItemRequest = { ...item, id: itemId };
      const local = {
        id: itemId,
        text: itemWithId.text,
        completed: itemWithId.completed ?? false,
        position: itemWithId.position,
        parent_id: itemWithId.parent_id ?? null,
        assigned_to: itemWithId.assigned_to ?? '',
      };
      if (isConnectedRef.current) {
        try {
          await createNoteItem(noteId, itemWithId);
          await createLocalItem(db, noteId, local);
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): write locally and queue.
      await createLocalItem(db, noteId, local);
      await enqueueOperation(db, {
        operation: 'createItem',
        endpoint: `/notes/${noteId}/items`,
        method: 'POST',
        body: itemWithId as unknown as Record<string, unknown>,
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
        try {
          await updateNoteItem(noteId, itemId, data);
          await patchLocalItem(db, noteId, itemId, data);
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): write locally and queue.
      await patchLocalItem(db, noteId, itemId, data);
      await enqueueOperation(db, {
        operation: 'updateItem',
        endpoint: `/notes/${noteId}/items/${itemId}`,
        method: 'PATCH',
        body: data as Record<string, unknown>,
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
        try {
          await deleteNoteItem(noteId, itemId);
          await deleteLocalItem(db, noteId, itemId);
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): write locally and queue.
      await deleteLocalItem(db, noteId, itemId);
      await enqueueOperation(db, {
        operation: 'deleteItem',
        endpoint: `/notes/${noteId}/items/${itemId}`,
        method: 'DELETE',
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
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
        try {
          await reorderNoteItems(noteId, itemIds);
          await reorderLocalItems(db, noteId, itemIds);
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): write locally and queue.
      await reorderLocalItems(db, noteId, itemIds);
      await enqueueOperation(db, {
        operation: 'reorderItems',
        endpoint: `/notes/${noteId}/items/reorder`,
        method: 'POST',
        body: { item_ids: itemIds } as Record<string, unknown>,
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
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
        try {
          await deleteNote(id);
          await markLocalNoteDeleted(db, id);
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): write locally and queue.
      await markLocalNoteDeleted(db, id);
      await enqueueOperation(db, {
        operation: 'delete',
        endpoint: `/notes/${id}`,
        method: 'DELETE',
      });
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
        try {
          await restoreNote(id);
          await markLocalNoteRestored(db, id);
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): write locally and queue.
      await markLocalNoteRestored(db, id);
      await enqueueOperation(db, {
        operation: 'restore',
        endpoint: `/notes/${id}/restore`,
        method: 'POST',
      });
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
        try {
          await permanentDeleteNote(id);
          await permanentDeleteLocalNote(db, id);
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): write locally and queue.
      await permanentDeleteLocalNote(db, id);
      await enqueueOperation(db, {
        operation: 'permanentDelete',
        endpoint: `/notes/${id}?permanent=true`,
        method: 'DELETE',
      });
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
        try {
          await reorderNotes(noteIds);
          // Update positions in local DB to match the new order
          for (let i = 0; i < noteIds.length; i++) {
            await updateLocalNote(db, noteIds[i], { position: i });
          }
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): update local positions to
      // reflect the new order immediately, then enqueue.
      for (let i = 0; i < noteIds.length; i++) {
        await updateLocalNote(db, noteIds[i], { position: i });
      }
      await enqueueOperation(db, {
        operation: 'reorder',
        endpoint: '/notes/reorder',
        method: 'POST',
        body: { note_ids: noteIds } as Record<string, unknown>,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

export function useNoteShares(noteId: string | null) {
  const { data: note, isLoading, isError } = useOfflineNote(noteId);
  return {
    data: note?.shared_with,
    isLoading,
    isError,
  };
}

export function useShareNote() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const { user: currentUser } = useAuth();

  return useMutation({
    mutationFn: async ({ noteId, user }: { noteId: string; user: User }) => {
      assertSwitchWriteAllowed();
      if (isLocalId(noteId)) {
        throw new Error('cannot share unsynced note');
      }

      if (isConnectedRef.current) {
        try {
          await shareNote(noteId, user.id);
          // Fetch updated note so shared_with_json in SQLite reflects server state
          try {
            const updated = await getNote(noteId);
            await saveNote(db, updated);
          } catch { /* share succeeded; note will sync on next background refresh */ }
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
          // Transient failure — fall through to offline queue
        }
      }

      // Offline path: optimistic local update + enqueue
      const note = await getLocalNote(db, noteId);
      if (!note) throw new Error(`Note ${noteId} not found in local cache`);
      const existing = note.shared_with ?? [];
      if (!existing.some((s) => s.shared_with_user_id === user.id)) {
        const optimisticShare: NoteShare = {
          id: `optimistic_${user.id}`,
          note_id: noteId,
          shared_with_user_id: user.id,
          shared_by_user_id: currentUser?.id ?? '',
          permission_level: 'write',
          username: user.username,
          first_name: user.first_name,
          last_name: user.last_name,
          has_profile_icon: user.has_profile_icon,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await saveNote(db, { ...note, is_shared: true, shared_with: [...existing, optimisticShare] });
      }
      await enqueueOperation(db, {
        operation: 'share',
        endpoint: `/notes/${noteId}/share`,
        method: 'POST',
        body: { user_id: user.id },
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

export function useUnshareNote() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, userId }: { noteId: string; userId: string }) => {
      assertSwitchWriteAllowed();
      if (isLocalId(noteId)) {
        throw new Error('cannot unshare unsynced note');
      }

      if (isConnectedRef.current) {
        try {
          await unshareNote(noteId, userId);
          try {
            const updated = await getNote(noteId);
            await saveNote(db, updated);
          } catch { /* unshare succeeded; note will sync on next background refresh */ }
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }

      // Offline path: optimistic local update + enqueue
      const note = await getLocalNote(db, noteId);
      if (!note) throw new Error(`Note ${noteId} not found in local cache`);
      const updatedShares = (note.shared_with ?? []).filter(
        (s) => s.shared_with_user_id !== userId,
      );
      await saveNote(db, { ...note, is_shared: updatedShares.length > 0, shared_with: updatedShares });
      await enqueueOperation(db, {
        operation: 'unshare',
        endpoint: `/notes/${noteId}/shares/${userId}`,
        method: 'DELETE',
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

export function useToggleNoteItemCompleted() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  return useMutation({
    mutationFn: async ({ noteId, itemId, completed }: { noteId: string; itemId: string; completed: boolean }): Promise<NoteItem[]> => {
      assertSwitchWriteAllowed();
      if (isConnectedRef.current) {
        try {
          const serverItems = await toggleItemCompleted(noteId, itemId, completed);
          for (const item of serverItems) {
            await patchLocalItem(db, noteId, item.id, { completed: item.completed });
          }
          return serverItems;
        } catch (err) {
          // Transient failure: fall through to the offline path so the toggle is
          // applied locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): apply cascade to local DB,
      // enqueue a single toggle op.
      const note = await getLocalNote(db, noteId);
      if (note && note.note_type === 'list' && note.items) {
        const target = note.items.find((i) => i.id === itemId);
        if (target) {
          const cascadeToChildren = target.parent_id === null;
          const patches: Array<{ id: string; patch: LocalItemPatch }> = [];
          for (const item of note.items) {
            const shouldToggle =
              item.id === itemId || (cascadeToChildren && item.parent_id === itemId);
            if (shouldToggle && item.completed !== completed) {
              patches.push({ id: item.id, patch: { completed } });
            }
          }
          for (const { id, patch } of patches) {
            await patchLocalItem(db, noteId, id, patch);
          }
        }
      }
      await enqueueOperation(db, {
        operation: 'toggleItemCompleted',
        endpoint: `/notes/${noteId}/items/${itemId}/toggle-completed`,
        method: 'POST',
        body: { completed } as Record<string, unknown>,
      });
      return [];
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesQueryScopeKey() });
    },
  });
}

// Re-export for convenience in screens that want explicit local-DB backed queries
export { saveNotes };
