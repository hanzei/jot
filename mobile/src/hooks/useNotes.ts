import { useRef } from 'react';
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import {
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
  CreateNoteRequest,
  UpdateNoteRequest,
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
  generateClientNoteId,
  markNotePendingCreate,
  isNotePendingCreate,
  isLocalId,
  createLocalItem,
  patchLocalItem,
  deleteLocalItem,
  reorderLocalItems,
} from '../db/noteQueries';
import { enqueueOperation, rethrowIfNotQueueable } from '../db/syncQueue';
import { useNetworkStatus } from './useNetworkStatus';
import { useAuth } from '../store/AuthContext';
import { isServerSwitchInProgress } from '../api/client';
import {
  noteLocalQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

function assertSwitchWriteAllowed(): void {
  if (isServerSwitchInProgress()) {
    throw new Error('Server switch in progress; write blocked');
  }
}

/**
 * Collects the item ids a completed-toggle should cascade to, mirroring the
 * server: toggling a top-level item also toggles its direct children. Only ids
 * whose `completed` actually changes are returned. Shared by the optimistic
 * cache update and the offline local-DB write so the two stay in agreement.
 *
 * (NoteEditorScreen keeps a parallel `applyCompletedCascade` over its own
 * `LocalItem[]` editor state; keep the cascade rule here in sync with it.)
 */
function collectToggleCascade(items: NoteItem[], itemId: string, completed: boolean): string[] {
  const target = items.find((i) => i.id === itemId);
  if (!target) return [];
  const cascadeToChildren = target.parent_id === null;
  return items
    .filter(
      (i) =>
        (i.id === itemId || (cascadeToChildren && i.parent_id === itemId)) &&
        i.completed !== completed,
    )
    .map((i) => i.id);
}

/** Returns a copy of `items` with the completed-toggle cascade applied. */
function applyToggleToItems(items: NoteItem[], itemId: string, completed: boolean): NoteItem[] {
  const ids = new Set(collectToggleCascade(items, itemId, completed));
  if (ids.size === 0) return items;
  return items.map((i) => (ids.has(i.id) ? { ...i, completed } : i));
}

/**
 * Snapshot of the cache entries an optimistic note write touches, captured by
 * `applyOptimisticNote` so `rollbackOptimisticNote` can restore them if the
 * write ultimately fails. We record the affected note's *prior entry* per list
 * (not the whole list array) so rollback restores only that note, leaving
 * concurrent optimistic edits to other notes in the same list untouched.
 */
interface OptimisticNoteSnapshot {
  previousNote: Note | undefined;
  previousListEntries: { key: QueryKey; note: Note }[];
}

/**
 * Optimistically applies `transform` to a note in both the single-note cache
 * and every cached notes-list, returning a snapshot for rollback. Reflecting
 * the change in the cache up front lets a slow/half-open connection feel as
 * snappy as a fully-offline write while the network reconcile runs in the
 * background; pair with `rollbackOptimisticNote` in the mutation's `onError`.
 */
function applyOptimisticNote(
  queryClient: QueryClient,
  noteId: string,
  transform: (note: Note) => Note,
): OptimisticNoteSnapshot {
  const previousNote = queryClient.getQueryData<Note>(noteLocalQueryKey(noteId));
  if (previousNote) {
    queryClient.setQueryData<Note>(noteLocalQueryKey(noteId), transform(previousNote));
  }
  const previousListEntries: { key: QueryKey; note: Note }[] = [];
  for (const [key, list] of queryClient.getQueriesData<Note[]>({ queryKey: notesLocalQueryScopeKey() })) {
    const prior = list?.find((n) => n.id === noteId);
    if (!prior) continue;
    previousListEntries.push({ key, note: prior });
    queryClient.setQueryData<Note[]>(key, (old) => old?.map((n) => (n.id === noteId ? transform(n) : n)));
  }
  return { previousNote, previousListEntries };
}

/** Reverts the optimistic cache entries captured by an onMutate snapshot. */
function rollbackOptimisticNote(
  queryClient: QueryClient,
  noteId: string,
  context: OptimisticNoteSnapshot | undefined,
): void {
  if (!context) return;
  if (context.previousNote !== undefined) {
    queryClient.setQueryData(noteLocalQueryKey(noteId), context.previousNote);
  }
  // Restore only the affected note within each list (reading current cache) so a
  // failed write doesn't wipe newer optimistic edits to other notes in the list.
  for (const { key, note } of context.previousListEntries) {
    queryClient.setQueryData<Note[]>(key, (old) => old?.map((n) => (n.id === noteId ? note : n)));
  }
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
      // server operation. The note gets a server-valid ID up front so it is sent
      // as the note's primary key on replay, making the queued create idempotent
      // (issue #475) — no server-side ID reconciliation needed.
      const clientId = generateClientNoteId();
      const now = new Date().toISOString();
      const labels: Label[] = [];
      const shared_with: NoteShare[] = [];
      const baseLocalNote = {
        id: clientId,
        user_id: user?.id ?? '',
        // A brand-new note starts at version 1, matching the server's default;
        // the first successful sync replaces it with the canonical server note.
        version: 1,
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
                  note_id: clientId,
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
      // Flag it unsynced until the queued create drains, so the UI gates actions
      // that need a server-side note (sharing, labels) in the meantime.
      await markNotePendingCreate(db, clientId);
      await enqueueOperation(db, {
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: { ...data, id: clientId } as Record<string, unknown>,
      });
      return localNote;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
    onMutate: ({ id, data }: { id: string; data: UpdateNoteRequest }) => {
      const now = new Date().toISOString();
      return applyOptimisticNote(queryClient, id, (note) => ({ ...note, ...data, updated_at: now }));
    },
    mutationFn: async ({ id, data }: { id: string; data: UpdateNoteRequest }): Promise<Note> => {
      assertSwitchWriteAllowed();

      const existing = await getLocalNote(db, id);
      // Only content edits (title/content) are version-guarded; per-user fields
      // (color/pinned/archived/collapsed) live in note_user_state and aren't.
      const fields = data as { title?: string; content?: string };
      const touchesContent = fields.title !== undefined || fields.content !== undefined;

      if (isConnectedRef.current) {
        try {
          // Online: gate on the version we currently hold locally so the server
          // can reject a write that raced a concurrent edit on another device
          // (#489). A 409 is permanent, so rethrowIfNotQueueable surfaces it.
          const body: UpdateNoteRequest =
            touchesContent && existing ? { ...data, base_version: existing.version } : data;
          const updatedNote = await updateNote(id, body);
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
      if (!existing) {
        throw new Error(`Note ${id} not found in local DB`);
      }
      const now = new Date().toISOString();

      // List items are edited via the granular item mutations, so this path only
      // carries scalar fields for both note types (title/content/pinned/archived/
      // color/collapsed).
      await updateLocalNote(db, id, data);

      // Queue only the fields the user actually changed. The server PATCH is a
      // partial update (absent fields are left unchanged), so sending the full
      // snapshot would re-assert stale values and clobber fields edited
      // concurrently on another device when this op replays later. base_version is
      // intentionally NOT stored here: drainQueue resolves it from the note's
      // local version at replay time, so a chain of offline edits to one note
      // replays against the advancing version instead of self-conflicting (#489).
      await enqueueOperation(db, {
        operation: 'update',
        endpoint: `/notes/${id}`,
        method: 'PATCH',
        body: data as Record<string, unknown>,
      });

      // Build the optimistic return from the data we already have.
      return { ...existing, ...data, updated_at: now };
    },
    // Roll back the optimistic edit so a failed write doesn't leave a phantom on screen.
    onError: (_err, { id }, context) => rollbackOptimisticNote(queryClient, id, context),
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(noteLocalQueryKey(updatedNote.id), updatedNote);
      // Synchronously patch the note in every cached notes-list so the dashboard
      // shows fresh content immediately on navigation back, without waiting for
      // the async SQLite refetch that invalidateQueries schedules below.
      queryClient.setQueriesData<Note[]>(
        { queryKey: notesLocalQueryScopeKey() },
        (old) => old?.map((n) => (n.id === updatedNote.id ? updatedNote : n)),
      );
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
      // Guard up front: duplicating an unsynced note is never safe — the server
      // doesn't know its ID yet, so both the online API call and the offline queue
      // entry would reference an ID the server can't resolve. Covers local-only
      // duplicates and offline creates still awaiting their POST (#475).
      if (isLocalId(id) || await isNotePendingCreate(db, id)) {
        throw new Error('Cannot duplicate an unsynced note; please wait until it has synced');
      }
      if (isConnectedRef.current) {
        try {
          const duplicatedNote = await duplicateNote(id);
          await saveNote(db, duplicatedNote);
          return duplicatedNote;
        } catch (err) {
          // Transient failure: fall through to the offline path so the duplicate
          // is created locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): create a local copy and queue
      // the server operation.
      const source = await getLocalNote(db, id);
      if (!source) {
        throw new Error(`Note ${id} not found in local DB`);
      }

      const localId = generateLocalId();
      const now = new Date().toISOString();
      const resetFields = {
        id: localId,
        pinned: false,
        archived: false,
        position: 0,
        is_shared: false,
        shared_with: [] as NoteShare[],
        deleted_at: null as string | null,
        created_at: now,
        updated_at: now,
      };
      const localDuplicate: Note = source.note_type === 'list'
        ? {
            ...source,
            ...resetFields,
            items: (() => {
              // Build a map from old item IDs to new local IDs so that parent_id
              // references within the duplicate point to the new items, not to items
              // in the source note. Items arrive in position order, so parents are
              // always mapped before their children are processed.
              const idRemap = new Map<string, string>();
              return (source.items ?? []).map((item) => {
                const newId = generateLocalId();
                idRemap.set(item.id, newId);
                return {
                  ...item,
                  id: newId,
                  note_id: localId,
                  parent_id: item.parent_id !== null ? (idRemap.get(item.parent_id) ?? item.parent_id) : null,
                  created_at: now,
                  updated_at: now,
                };
              });
            })(),
          }
        : { ...source, ...resetFields };

      await saveNote(db, localDuplicate);
      await enqueueOperation(db, {
        operation: 'duplicate',
        endpoint: `/notes/${id}/duplicate`,
        method: 'POST',
        body: { local_id: localId } as Record<string, unknown>,
      });
      return localDuplicate;
    },
    onSuccess: (duplicatedNote) => {
      queryClient.setQueryData(noteLocalQueryKey(duplicatedNote.id), duplicatedNote);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
      // A local_* duplicate has no server-side id yet (it awaits id reconciliation),
      // so it can never be shared.
      if (isLocalId(noteId)) {
        throw new Error('cannot share unsynced note');
      }
      // An offline-created note already carries a server-valid id (#475) and its
      // queued create drains FIFO before this share, so queue the share rather than
      // attempting it online — the server doesn't know the note yet, so a direct
      // call would 404 (permanent) and surface as an error instead of syncing.
      const pendingCreate = await isNotePendingCreate(db, noteId);

      if (isConnectedRef.current && !pendingCreate) {
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
      // A local_* duplicate has no server-side id yet, so there is nothing to unshare.
      if (isLocalId(noteId)) {
        throw new Error('cannot unshare unsynced note');
      }
      // An offline-created note (#475) drains its create FIFO before this unshare,
      // so queue rather than calling online against a note the server doesn't know yet.
      const pendingCreate = await isNotePendingCreate(db, noteId);

      if (isConnectedRef.current && !pendingCreate) {
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
    onMutate: ({ noteId, itemId, completed }: { noteId: string; itemId: string; completed: boolean }) =>
      applyOptimisticNote(queryClient, noteId, (note) =>
        note.note_type === 'list' && note.items
          ? { ...note, items: applyToggleToItems(note.items, itemId, completed) }
          : note,
      ),
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
        for (const id of collectToggleCascade(note.items, itemId, completed)) {
          await patchLocalItem(db, noteId, id, { completed });
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
    // Revert the optimistic toggle if the write ultimately fails.
    onError: (_err, { noteId }, context) => rollbackOptimisticNote(queryClient, noteId, context),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

// Re-export for convenience in screens that want explicit local-DB backed queries
export { saveNotes };
