import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import {
  getNote,
  createNote,
  updateNote,
  deleteNote,
  restoreNote,
  duplicateNote,
  convertNoteType,
  permanentDeleteNote,
  reorderNotes,
  createNoteItem,
  updateNoteItem,
  deleteNoteItem,
  reorderNoteItems,
  toggleItemCompleted,
  uncheckAllItems,
  deleteCompletedItems,
} from '../api/notes';
import { shareNote, unshareNote } from '../api/users';
import { useOfflineNote } from './useOfflineNotes';
import { DEFAULT_NOTE_COLOR, generateId, textToListNote, listToText, checkConvertToListCaps, applyCompletedCascade, type ListItem } from '@jot/shared';
import type {
  Note,
  NoteItem,
  NoteShare,
  User,
  Label,
  CreateNoteRequest,
  UpdateNoteRequest,
  ConvertNoteTypeRequest,
  CreateNoteItemRequest,
  PatchNoteItemRequest,
  ConvertToListCapViolation,
} from '@jot/shared';
import {
  saveNote,
  saveNotes,
  getLocalNote,
  markLocalNoteDeleted,
  markLocalNoteRestored,
  permanentDeleteLocalNote,
  updateLocalNote,
  generateClientNoteId,
  markNotePendingCreate,
  isNotePendingCreate,
  createLocalItem,
  patchLocalItem,
  deleteLocalItem,
  reorderLocalItems,
  setLocalItemsCompleted,
  deleteLocalItems,
  reconcileLocalItems,
} from '../db/noteQueries';
import { enqueueOperation, rethrowIfNotQueueable } from '../db/syncQueue';
import { isOnlineWriteAllowed } from '../api/serverReachability';
import { useNetworkStatus } from './useNetworkStatus';
import { useAuth } from '../store/AuthContext';
import { assertSwitchWriteAllowed } from '../api/client';
import {
  labelCountsQueryKey,
  noteLocalQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

/**
 * Collects the item ids a completed-toggle should cascade to, via the shared
 * `applyCompletedCascade` (the same rule NoteEditorScreen applies to its own
 * editor state). This is a shape adapter, not a fourth implementation: it maps
 * the server-shaped `NoteItem[]` (`parent_id`) to `@jot/shared`'s `ListItem[]`
 * (`parentId`) and back to a list of changed ids, for the optimistic cache
 * update and the offline local-DB write.
 */
function collectToggleCascade(items: NoteItem[], itemId: string, completed: boolean): string[] {
  const asListItems: ListItem[] = items.map((i) => ({
    id: i.id,
    text: i.text,
    completed: i.completed,
    position: i.position,
    parentId: i.parent_id,
    assigned_to: i.assigned_to,
  }));
  const completedById = new Map(items.map((i) => [i.id, i.completed]));
  return applyCompletedCascade(asListItems, itemId, completed)
    .filter((i) => completedById.get(i.id) !== i.completed)
    .map((i) => i.id);
}

/** Returns a copy of `items` with the completed-toggle cascade applied. */
function applyToggleToItems(items: NoteItem[], itemId: string, completed: boolean): NoteItem[] {
  const ids = new Set(collectToggleCascade(items, itemId, completed));
  if (ids.size === 0) return items;
  return items.map((i) => (ids.has(i.id) ? { ...i, completed } : i));
}

/**
 * Applies a completed-toggle cascade to the note's rows in SQLite, returning the
 * ids it changed so a permanent failure can put them back.
 *
 * Every id the cascade yields is one whose value actually flips, so the whole
 * set moves to `completed` in one grouped write and reverting is the same call
 * with `!completed` — no per-id transaction, and no window where a re-read can
 * catch a parent checked but its children not.
 */
async function applyToggleToLocalItems(
  db: SQLiteDatabase,
  noteId: string,
  itemId: string,
  completed: boolean,
): Promise<string[]> {
  const note = await getLocalNote(db, noteId);
  if (!note || note.note_type !== 'list' || !note.items) return [];
  const ids = collectToggleCascade(note.items, itemId, completed);
  await setLocalItemsCompleted(db, noteId, ids, completed);
  return ids;
}

/**
 * Stops any in-flight read of this note before an optimistic write patches the
 * cache. Without it a refetch that started first can still resolve afterwards
 * and overwrite the patch with the pre-write note — the same visible revert
 * that a re-read *during* the request causes, just from the other direction.
 */
async function cancelNoteReads(queryClient: QueryClient, noteId: string): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: noteLocalQueryKey(noteId) }),
    queryClient.cancelQueries({ queryKey: notesLocalQueryScopeKey() }),
  ]);
}

/** Returns a copy of `items` with `completed` set on every id in `itemIds`. */
function applySetCompletedToItems(items: NoteItem[], itemIds: string[], completed: boolean): NoteItem[] {
  const ids = new Set(itemIds);
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

/**
 * Refreshes the drawer's per-label counts.
 *
 * They are derived from the notes table, not the labels one: `getLocalLabelCounts`
 * counts each label across the *active* notes (archived and trashed excluded). So
 * a write that changes nothing about a note's labels still changes its counts by
 * moving the note in or out of that set — archiving, trashing, restoring,
 * duplicating — and every such path has to say so.
 *
 * Membership edits (add/remove/rename/delete a label) go through useLabels.ts,
 * which already invalidates this, as does the SSE handler for every remote note
 * event. This is the local-write side of the same rule.
 */
function invalidateLabelCounts(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: CreateNoteRequest): Promise<Note> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
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

      // Pre-assign a permanent, server-format ID to every list item so the *same*
      // ID backs the local row and is sent in the create body. The server honors
      // client-supplied item IDs (see createBulkListItem), so the item's identity
      // is stable from creation — no `local_* → server ID` reconciliation on drain
      // (issues #513/#475), and a later per-item edit queued before the create
      // drains still references a valid ID. In local mode there is no server to
      // reconcile against, so this permanent ID is simply terminal.
      const itemsWithIds =
        data.note_type === 'list'
          ? (data.items ?? []).map((item) => ({ ...item, id: item.id ?? generateId() }))
          : undefined;
      const baseLocalNote = {
        id: clientId,
        user_id: user?.id ?? '',
        // A brand-new note starts at version 1, matching the server's default;
        // the first successful sync replaces it with the canonical server note.
        version: 1,
        color: data.color ?? DEFAULT_NOTE_COLOR,
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
              return (itemsWithIds ?? []).map((item, i) => {
                const isChild = (item.indent_level ?? 0) === 1;
                const parentId = isChild ? lastTopLevelId : null;
                if (!isChild) lastTopLevelId = item.id;
                return {
                  id: item.id,
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
        // Carry the pre-assigned item IDs so the server keeps them (no
        // reconciliation) and the local rows stay valid for any per-item edit
        // queued behind this create (#513).
        body: {
          ...data,
          ...(itemsWithIds ? { items: itemsWithIds } : {}),
          id: clientId,
        } as Record<string, unknown>,
      });
      return localNote;
    },
    onSuccess: (_note, data) => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // A create can carry labels (the sync-failure fork does), which the new
      // note then counts towards.
      if (data.labels?.length) invalidateLabelCounts(queryClient);
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

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

      if (isOnlineWriteAllowed(isConnected)) {
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
    onSuccess: (updatedNote, { data }) => {
      queryClient.setQueryData(noteLocalQueryKey(updatedNote.id), updatedNote);
      // Synchronously patch the note in every cached notes-list so the dashboard
      // shows fresh content immediately on navigation back, without waiting for
      // the async SQLite refetch that invalidateQueries schedules below.
      queryClient.setQueriesData<Note[]>(
        { queryKey: notesLocalQueryScopeKey() },
        (old) => old?.map((n) => (n.id === updatedNote.id ? updatedNote : n)),
      );
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // Only the archive flag moves a note in or out of the counted set; a
      // title/content save must not re-scan every note's labels on each debounce.
      if (data.archived !== undefined) invalidateLabelCounts(queryClient);
    },
  });
}

/**
 * Computes the precomputed `content`/`title`/`items` for converting `note` to
 * the opposite type, via the same shared transform
 * (`textToListNote`/`listToText`) the webapp uses — the server only validates
 * and persists whatever is sent (issue #676). Converting to a list promotes a
 * leading heading in the content into the list's title, the inverse of the
 * `# Title` line `listToText` writes in the other direction. Item ids are
 * generated here (rather than left for the server)
 * so they stay stable across a chain of offline edits: a per-item mutation
 * queued right after an offline convert, but before it drains, can then target
 * the same id the eventual server row will have (mirrors useDuplicateNote's
 * client-supplied item ids). Deliberately excludes `base_version`: the online
 * path stamps the version current at call time, while the offline/replay path
 * resolves it fresh at drain time (see the `update` operation's handling, #489).
 */
/**
 * Thrown by `buildConvertNoteTypeRequest` when a text→list conversion would
 * exceed an item cap the server enforces. Thrown before either the online
 * request or the offline apply/enqueue below it, so a note that would be
 * rejected never reaches the sync queue in the first place — the offline
 * replay would otherwise reject it later with no way to explain why.
 */
export class NoteConversionCapError extends Error {
  readonly kind: ConvertToListCapViolation['kind'];
  readonly max: number;

  constructor(violation: ConvertToListCapViolation) {
    super(`Conversion exceeds cap: ${violation.kind} (max ${violation.max})`);
    this.name = 'NoteConversionCapError';
    this.kind = violation.kind;
    this.max = violation.max;
  }
}

function buildConvertNoteTypeRequest(note: Note): ConvertNoteTypeRequest {
  if (note.note_type === 'list') {
    return {
      note_type: 'text',
      content: listToText(note.title, note.items ?? []),
    };
  }
  const converted = textToListNote(note.content);
  const violation = checkConvertToListCaps(converted);
  if (violation) {
    throw new NoteConversionCapError(violation);
  }
  return {
    note_type: 'list',
    title: converted.title,
    items: converted.items.map((item, index) => ({
      id: generateId(),
      text: item.text,
      position: index,
      completed: item.completed,
      // The server rebuilds parent_id from this; applyConvertedNoteLocally
      // mirrors that reconstruction so the offline result matches.
      indent_level: item.indentLevel,
    })),
  };
}

/**
 * Applies a precomputed convert request to `note` locally, mirroring what the
 * server persists (`convertNoteRowTx`): the title is taken from the request
 * (cleared when converting to text, since a text note has none), and items are
 * fully replaced (not merged) in the target-list direction.
 */
function applyConvertedNoteLocally(note: Note, data: ConvertNoteTypeRequest, now: string): Note {
  if (data.note_type === 'text') {
    return { ...note, note_type: 'text', content: data.content ?? '', updated_at: now };
  }
  // Mirrors the server's buildCreateNoteItems: an item sent with indent_level 1
  // hangs off the nearest preceding top-level item, and off nothing when there is
  // no such item yet. buildConvertNoteTypeRequest emits items in position order,
  // which is the order the server sorts into before doing the same walk.
  let lastTopLevelId: string | null = null;
  const items: NoteItem[] = (data.items ?? []).map((item) => {
    const id = item.id ?? generateId();
    const parentId = item.indent_level === 1 ? lastTopLevelId : null;
    // Only a top-level item becomes the parent for what follows. An indented item
    // that found no parent stays childless rather than adopting the next one.
    if (item.indent_level !== 1) lastTopLevelId = id;
    return {
      id,
      note_id: note.id,
      text: item.text,
      completed: item.completed ?? false,
      position: item.position,
      parent_id: parentId,
      assigned_to: '',
      created_at: now,
      updated_at: now,
    };
  });
  return { ...note, note_type: 'list', title: data.title ?? '', checked_items_collapsed: false, items, updated_at: now };
}

export function useConvertNoteType() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    mutationFn: async (id: string): Promise<Note> => {
      assertSwitchWriteAllowed();

      const existing = await getLocalNote(db, id);
      if (!existing) {
        throw new Error(`Note ${id} not found in local DB`);
      }
      const data = buildConvertNoteTypeRequest(existing);

      if (isOnlineWriteAllowed(isConnected)) {
        try {
          const convertedNote = await convertNoteType(id, { ...data, base_version: existing.version });
          await saveNote(db, convertedNote);
          return convertedNote;
        } catch (err) {
          // Transient failure: fall through to the offline path so the
          // conversion is applied locally and queued for replay instead of
          // being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): apply the same precomputed
      // transform to local SQLite and queue the operation for replay.
      const now = new Date().toISOString();
      const localConverted = applyConvertedNoteLocally(existing, data, now);
      await saveNote(db, localConverted);
      await enqueueOperation(db, {
        operation: 'convertNoteType',
        endpoint: `/notes/${id}/convert`,
        method: 'POST',
        body: data as unknown as Record<string, unknown>,
      });
      return localConverted;
    },
    onSuccess: (convertedNote) => {
      queryClient.setQueryData(noteLocalQueryKey(convertedNote.id), convertedNote);
      queryClient.setQueriesData<Note[]>(
        { queryKey: notesLocalQueryScopeKey() },
        (old) => old?.map((n) => (n.id === convertedNote.id ? convertedNote : n)),
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
      if (isOnlineWriteAllowed(isConnected)) {
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

  return useMutation({
    mutationFn: async ({ noteId, itemId, data }: { noteId: string; itemId: string; data: PatchNoteItemRequest }): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
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

  return useMutation({
    mutationFn: async ({ noteId, itemId }: { noteId: string; itemId: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
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

  return useMutation({
    mutationFn: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
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

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
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
      // Trashing drops the note out of its labels' counts.
      invalidateLabelCounts(queryClient);
    },
  });
}

export function useDuplicateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    mutationFn: async (id: string): Promise<Note> => {
      assertSwitchWriteAllowed();
      // An offline-created note already carries a server-valid id (#475) and its
      // queued create drains FIFO before this duplicate, so queue rather than
      // calling online against a note the server doesn't know yet (a 404 would
      // surface as an error instead of syncing).
      const pendingCreate = await isNotePendingCreate(db, id);
      if (isOnlineWriteAllowed(isConnected) && !pendingCreate) {
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

      // Offline (or a transient online failure): create a local copy with a
      // server-valid client ID and queue the server operation. The client ID is
      // sent in the request body so the server keeps it — making the replay
      // idempotent (same ID → 409, treated as already-applied, no second copy).
      const source = await getLocalNote(db, id);
      if (!source) {
        throw new Error(`Note ${id} not found in local DB`);
      }

      const clientId = generateClientNoteId();
      const now = new Date().toISOString();
      const resetFields = {
        id: clientId,
        pinned: false,
        archived: false,
        position: 0,
        is_shared: false,
        shared_with: [] as NoteShare[],
        deleted_at: null as string | null,
        created_at: now,
        updated_at: now,
      };
      // Build a source→new item ID map for list notes. This is captured here
      // (outside the items spread) so we can send it to the server, letting it
      // honor the same IDs. That way any per-item edits queued after this
      // duplicate—but before it drains—still target valid server item IDs.
      const idRemap = new Map<string, string>();
      const localDuplicate: Note = source.note_type === 'list'
        ? {
            ...source,
            ...resetFields,
            items: (source.items ?? []).map((item) => {
              const newId = generateId();
              idRemap.set(item.id, newId);
              return {
                ...item,
                id: newId,
                note_id: clientId,
                parent_id: item.parent_id !== null ? (idRemap.get(item.parent_id) ?? item.parent_id) : null,
                created_at: now,
                updated_at: now,
              };
            }),
          }
        : { ...source, ...resetFields };

      const itemIds = idRemap.size > 0 ? Object.fromEntries(idRemap) : undefined;
      await saveNote(db, localDuplicate);
      await markNotePendingCreate(db, clientId);
      await enqueueOperation(db, {
        operation: 'duplicate',
        endpoint: `/notes/${id}/duplicate`,
        method: 'POST',
        body: { id: clientId, ...(itemIds ? { item_ids: itemIds } : {}) } as Record<string, unknown>,
      });
      return localDuplicate;
    },
    onSuccess: (duplicatedNote) => {
      queryClient.setQueryData(noteLocalQueryKey(duplicatedNote.id), duplicatedNote);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // The copy keeps the source's labels, so each of them gains a note.
      if (duplicatedNote.labels.length > 0) invalidateLabelCounts(queryClient);
    },
  });
}

export function useRestoreNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
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
      // Restoring puts the note back into its labels' counts.
      invalidateLabelCounts(queryClient);
    },
  });
}

export function usePermanentDeleteNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
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

/**
 * Snapshot of the notes-list cache entries an optimistic reorder touches, for
 * rollback if the reorder ultimately fails.
 */
interface OptimisticReorderSnapshot {
  key: QueryKey;
  notes: Note[];
}

/**
 * Optimistically re-sorts every cached notes-list to match `noteIds`,
 * returning a snapshot for rollback. Without this, the cache keeps its
 * pre-drag order until the reorder's network round-trip and refetch land —
 * and any *other* mutation's cache write in that window (e.g. archiving a
 * note right after dragging it) recreates the list's array reference from
 * that stale order, which trips NotesListScreen's `localOrder`-clearing
 * effect and reveals the pre-drag order for one render (#815).
 *
 * Only lists whose *entire* contents `noteIds` accounts for are reordered —
 * a filtered/partial list (search, label, archived) may share ids with
 * `noteIds` without this drag applying to its own ordering, so leave those
 * alone rather than guess.
 */
function applyOptimisticReorder(queryClient: QueryClient, noteIds: string[]): OptimisticReorderSnapshot[] {
  const orderIndex = new Map(noteIds.map((id, index) => [id, index]));
  const previousListEntries: OptimisticReorderSnapshot[] = [];
  for (const [key, list] of queryClient.getQueriesData<Note[]>({ queryKey: notesLocalQueryScopeKey() })) {
    if (!list || list.length === 0 || !list.every((note) => orderIndex.has(note.id))) continue;
    previousListEntries.push({ key, notes: list });
    const reordered = [...list].sort((a, b) => orderIndex.get(a.id)! - orderIndex.get(b.id)!);
    queryClient.setQueryData<Note[]>(key, reordered);
  }
  return previousListEntries;
}

/** Reverts the optimistic cache entries captured by an onMutate snapshot. */
function rollbackOptimisticReorder(queryClient: QueryClient, snapshot: OptimisticReorderSnapshot[]): void {
  for (const { key, notes } of snapshot) {
    queryClient.setQueryData<Note[]>(key, notes);
  }
}

export function useReorderNotes() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    mutationFn: async (noteIds: string[]): Promise<void> => {
      assertSwitchWriteAllowed();
      if (isOnlineWriteAllowed(isConnected)) {
        try {
          await reorderNotes(noteIds);
          // Update positions in local DB to match the new order
          for (const [i, noteId] of noteIds.entries()) {
            await updateLocalNote(db, noteId, { position: i });
          }
          return;
        } catch (err) {
          rethrowIfNotQueueable(err);
        }
      }
      // Offline (or a transient online failure): update local positions to
      // reflect the new order immediately, then enqueue.
      for (const [i, noteId] of noteIds.entries()) {
        await updateLocalNote(db, noteId, { position: i });
      }
      await enqueueOperation(db, {
        operation: 'reorder',
        endpoint: '/notes/reorder',
        method: 'POST',
        body: { note_ids: noteIds } as Record<string, unknown>,
      });
    },
    onMutate: (noteIds: string[]) => applyOptimisticReorder(queryClient, noteIds),
    onError: (_err, _noteIds, snapshot) => {
      if (snapshot) rollbackOptimisticReorder(queryClient, snapshot);
    },
    // Reconcile with the real local DB after either outcome, not just success:
    // a rollback restores the pre-drag snapshot captured at onMutate time, which
    // can itself be stale if another mutation touched the same cache while this
    // one was in flight. Invalidating here re-pulls the true order either way.
    onSettled: () => {
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
  const { user: currentUser } = useAuth();

  return useMutation({
    mutationFn: async ({ noteId, user }: { noteId: string; user: User }) => {
      assertSwitchWriteAllowed();
      // An offline-created note already carries a server-valid id (#475) and its
      // queued create drains FIFO before this share, so queue the share rather than
      // attempting it online — the server doesn't know the note yet, so a direct
      // call would 404 (permanent) and surface as an error instead of syncing.
      const pendingCreate = await isNotePendingCreate(db, noteId);

      if (isOnlineWriteAllowed(isConnected) && !pendingCreate) {
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
      // Refresh the notes list so dashboard cards re-render collaborator avatars.
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

export function useUnshareNote() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    mutationFn: async ({ noteId, userId }: { noteId: string; userId: string }) => {
      assertSwitchWriteAllowed();
      // An offline-created note (#475) drains its create FIFO before this unshare,
      // so queue rather than calling online against a note the server doesn't know yet.
      const pendingCreate = await isNotePendingCreate(db, noteId);

      if (isOnlineWriteAllowed(isConnected) && !pendingCreate) {
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
      // Refresh the notes list so dashboard cards re-render collaborator avatars.
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

export function useToggleNoteItemCompleted() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    onMutate: async ({ noteId, itemId, completed }: { noteId: string; itemId: string; completed: boolean }) => {
      await cancelNoteReads(queryClient, noteId);
      return applyOptimisticNote(queryClient, noteId, (note) =>
        note.note_type === 'list' && note.items
          ? { ...note, items: applyToggleToItems(note.items, itemId, completed) }
          : note,
      );
    },
    mutationFn: async ({ noteId, itemId, completed }: { noteId: string; itemId: string; completed: boolean }): Promise<NoteItem[]> => {
      assertSwitchWriteAllowed();

      // Write the cascade to SQLite up front, before the request goes out. Both
      // note reads are SQLite-backed, so while the row still says unchecked any
      // re-read in that window (the queue drain's invalidation, a background
      // note sync, a sibling toggle's onSuccess) resolves to the pre-toggle note
      // and overwrites the optimistic cache above — the checked row visibly
      // comes back for the length of one round trip before the response
      // re-checks it. Writing first makes the local rows agree with the
      // optimistic cache for the whole flight, so a re-read is a no-op.
      const cascadeIds = await applyToggleToLocalItems(db, noteId, itemId, completed);

      if (isOnlineWriteAllowed(isConnected)) {
        try {
          const serverItems = await toggleItemCompleted(noteId, itemId, completed);
          for (const item of serverItems) {
            await patchLocalItem(db, noteId, item.id, { completed: item.completed });
          }
          return serverItems;
        } catch (err) {
          // Transient failure: fall through to the offline path so the toggle is
          // queued for replay instead of being lost. A permanent one takes the
          // local rows back with it, mirroring the cache rollback in onError —
          // otherwise the pre-flight write above would outlive the failed toggle.
          try {
            rethrowIfNotQueueable(err);
          } catch (permanent) {
            await setLocalItemsCompleted(db, noteId, cascadeIds, !completed);
            throw permanent;
          }
        }
      }

      // Offline (or a transient online failure): the cascade is already in the
      // local DB, so only the replay op is left to enqueue.
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

/**
 * Bulk-uncheck a caller-supplied set of item ids (the note's currently
 * completed items, captured at action time). Mirrors useToggleNoteItemCompleted's
 * online-try / offline-queue / optimistic-rollback structure, but over a set
 * of ids instead of a single item with cascade.
 */
export function useUncheckAllItems() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    onMutate: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }) => {
      await cancelNoteReads(queryClient, noteId);
      return applyOptimisticNote(queryClient, noteId, (note) =>
        note.note_type === 'list' && note.items
          ? { ...note, items: applySetCompletedToItems(note.items, itemIds, false) }
          : note,
      );
    },
    mutationFn: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }): Promise<NoteItem[]> => {
      assertSwitchWriteAllowed();
      if (itemIds.length === 0) return [];

      // Local rows first, for the reason spelled out in useToggleNoteItemCompleted:
      // a note re-read while the request is in flight must not resolve to the
      // still-checked rows and undo the optimistic uncheck on screen.
      await setLocalItemsCompleted(db, noteId, itemIds, false);

      if (isOnlineWriteAllowed(isConnected)) {
        try {
          const serverItems = await uncheckAllItems(noteId, itemIds);
          // The server returns the note's full, authoritative item list, so
          // reconcile every field (and prune any local row it no longer
          // contains) rather than just patching `completed`.
          await reconcileLocalItems(db, noteId, serverItems);
          return serverItems;
        } catch (err) {
          // Transient failure: fall through to the offline path so the change is
          // queued for replay instead of being lost. A permanent one re-checks
          // the local rows, mirroring the cache rollback in onError.
          try {
            rethrowIfNotQueueable(err);
          } catch (permanent) {
            await setLocalItemsCompleted(db, noteId, itemIds, true);
            throw permanent;
          }
        }
      }

      // Offline (or a transient online failure): the uncheck is already in the
      // local DB, so only the replay op is left to enqueue. It carries the exact
      // ids captured at click time.
      await enqueueOperation(db, {
        operation: 'uncheckAllItems',
        endpoint: `/notes/${noteId}/items/set-completed`,
        method: 'POST',
        body: { item_ids: itemIds, completed: false } as Record<string, unknown>,
      });
      return [];
    },
    // Revert the optimistic uncheck if the write ultimately fails.
    onError: (_err, { noteId }, context) => rollbackOptimisticNote(queryClient, noteId, context),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

/**
 * Bulk-delete a caller-supplied set of item ids (the note's currently
 * completed items, captured at action time). Mirrors useToggleNoteItemCompleted's
 * online-try / offline-queue / optimistic-rollback structure. Deleting exactly
 * the completed set never orphans a child: the completed-cascade invariant
 * (applyCompletedCascade / collectToggleCascade) guarantees a completed
 * parent's children are completed too, so they are always included in the
 * same delete.
 */
export function useDeleteCompletedItems() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();

  return useMutation({
    // Unlike the two completed-flag mutations above, the local rows are *not*
    // deleted before the request: restoring them after a permanent failure means
    // re-inserting rows rather than flipping a column back, and a delete that is
    // briefly undone on screen is far less likely than the checked-item flicker
    // (nothing re-reads a note between the confirm dialog and the response).
    // Cancelling in-flight reads still keeps a refetch already on the wire from
    // resolving over the optimistic removal.
    onMutate: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }) => {
      await cancelNoteReads(queryClient, noteId);
      return applyOptimisticNote(queryClient, noteId, (note) => {
        if (note.note_type !== 'list' || !note.items) return note;
        const ids = new Set(itemIds);
        return { ...note, items: note.items.filter((item) => !ids.has(item.id)) };
      });
    },
    mutationFn: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }): Promise<NoteItem[]> => {
      assertSwitchWriteAllowed();
      if (itemIds.length === 0) return [];
      if (isOnlineWriteAllowed(isConnected)) {
        try {
          const serverItems = await deleteCompletedItems(noteId, itemIds);
          // The server returns the note's full, authoritative remaining item
          // list; reconciling against it (rather than deleting exactly
          // `itemIds`) prunes precisely what the server actually removed.
          await reconcileLocalItems(db, noteId, serverItems);
          return serverItems;
        } catch (err) {
          // Transient failure: fall through to the offline path so the delete is
          // applied locally and queued for replay instead of being lost.
          rethrowIfNotQueueable(err);
        }
      }

      // Offline (or a transient online failure): delete locally, enqueue a
      // single bulk op carrying the exact ids captured at click time.
      await deleteLocalItems(db, noteId, itemIds);
      await enqueueOperation(db, {
        operation: 'deleteCompletedItems',
        endpoint: `/notes/${noteId}/items/delete`,
        method: 'POST',
        body: { item_ids: itemIds } as Record<string, unknown>,
      });
      return [];
    },
    // Revert the optimistic delete if the write ultimately fails.
    onError: (_err, { noteId }, context) => rollbackOptimisticNote(queryClient, noteId, context),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

// Re-export for convenience in screens that want explicit local-DB backed queries
export { saveNotes };
