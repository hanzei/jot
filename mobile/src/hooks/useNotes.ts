import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import { useOfflineNote } from './useOfflineNotes';
import { apiPaths, DEFAULT_NOTE_COLOR, generateId, textToListNote, listToText, checkConvertToListCaps, applyCompletedValues, completedCascadeScope, patchTouchesSharedContent } from '@jot/shared';
import type {
  Note,
  TextNote,
  ListNote,
  NoteItem,
  NoteShare,
  UserInfo,
  Label,
  CreateNoteRequest,
  UpdateNoteRequest,
  ConvertNoteTypeRequest,
  CreateNoteItemRequest,
  PatchNoteItemRequest,
  ReorderNoteItemsRequest,
  SetNoteItemsCompletedRequest,
  DeleteNoteItemsRequest,
  ReorderNotesRequest,
  DuplicateNoteRequest,
  MarkNoteViewedRequest,
  ShareNoteRequest,
  ConvertToListCapViolation,
} from '@jot/shared';
import {
  saveNotes,
  saveNoteInTx,
  getLocalNote,
  requireLocalNote,
  markLocalNoteDeleted,
  markLocalNoteRestored,
  clearLocalNoteUnread,
  permanentDeleteLocalNoteRows,
  deleteUploadFiles,
  updateLocalNote,
  generateClientNoteId,
  markNotePendingCreate,
  getNextLocalPinnedPosition,
  createLocalItem,
  patchLocalItem,
  deleteLocalItem,
  reorderLocalItems,
  setLocalItemsCompleted,
  deleteLocalItems,
} from '../db/noteQueries';
import { resolveOwnBaseVersion } from '../db/ownVersions';
import { labelKey, noteKey } from '../db/queueKeys';
import { enqueueWrite, type EnqueueParams } from '../db/syncQueue';
import { useAuth } from '../store/AuthContext';
import { assertSwitchWriteAllowed, isServerSwitchInProgress } from '../api/client';
import { resolveLocalLabel } from './useLabels';
import {
  labelsQueryKey,
  noteLocalQueryKey,
  notesLocalQueryScopeKey,
} from './queryKeys';

/**
 * The item ids a completed-toggle changes: the shared `completedCascadeScope`
 * (the same rule NoteEditorScreen applies to its own editor state), narrowed to
 * the ids whose value actually flips. A shape adapter, not another
 * implementation: it maps the server-shaped `parent_id` to the shared `parentId`.
 */
function collectToggleCascade(items: NoteItem[], itemId: string, completed: boolean): string[] {
  const completedById = new Map(items.map((i) => [i.id, i.completed]));
  return completedCascadeScope(items.map((i) => ({ id: i.id, parentId: i.parent_id })), itemId, completed)
    .filter((id) => completedById.get(id) !== completed);
}

/** Returns a copy of `items` with the completed-toggle cascade applied. */
function applyToggleToItems(items: NoteItem[], itemId: string, completed: boolean): NoteItem[] {
  return applyCompletedValues(items, new Map(collectToggleCascade(items, itemId, completed).map((id) => [id, completed])));
}

/** Invalidates a note's SQLite-backed reads, detail and lists. */
function invalidateNoteReads(queryClient: QueryClient, noteId: string): void {
  queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
  queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
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
 * the change in the cache up front shows it before the SQLite re-read lands;
 * pair with `rollbackOptimisticNote` in the mutation's `onError`.
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
 * Refreshes the drawer's label list, whose items carry the per-label counts.
 *
 * Offline, the counts are derived from the notes table: `getLocalLabelCounts`
 * counts each label across the *active* notes (archived and trashed excluded). So
 * a write that changes nothing about a note's labels still changes its counts by
 * moving the note in or out of that set — archiving, trashing, restoring,
 * duplicating — and every such path has to say so.
 *
 * Membership edits (add/remove/rename/delete a label) go through useLabels.ts,
 * which already invalidates this, as does the SSE handler for every remote note
 * event. This is the local-write side of the same rule.
 */
function invalidateLabelList(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: CreateNoteRequest): Promise<Note> => {
      assertSwitchWriteAllowed();
      // The note gets a server-valid ID up front and is sent under it, so the
      // queued create is idempotent (issue #475): a replay of a create the
      // server already committed gets a 409 (already applied) rather than
      // creating a second note (#1278).
      const clientId = generateClientNoteId();
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
      const now = new Date().toISOString();

      // Through the outbox (#1285): the note and its queue rows commit together.
      const { note } = await enqueueWrite(db, {
        localApply: async () => {
          // Attach the labels the create names (a new note labelled before it
          // existed, or a sync-failure fork) to the local row too. A label not
          // known locally gets its own create queued ahead of this note's, so
          // the server resolves the name to that same id.
          const labels: Label[] = [];
          const labelCreates: EnqueueParams[] = [];
          for (const name of data.labels ?? []) {
            const { label, create } = await resolveLocalLabel(db, name, user?.id ?? '');
            if (create) labelCreates.push(create);
            if (!labels.some((l) => l.id === label.id)) labels.push(label);
          }
          const baseLocalNote = {
            id: clientId,
            user_id: user?.id ?? '',
            // A brand-new note starts at version 1, matching the server's default;
            // the drained create replaces it with the canonical server note.
            version: 1,
            color: data.color ?? DEFAULT_NOTE_COLOR,
            pinned: data.pinned ?? false,
            archived: false,
            position: data.pinned ? await getNextLocalPinnedPosition(db) : 0,
            is_shared: false,
            unread: null,
            deleted_at: null as string | null,
            created_at: now,
            updated_at: now,
            labels,
            shared_with: [] as NoteShare[],
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
          await saveNoteInTx(db, localNote);
          // Flag it unsynced until the queued create drains, so the UI gates
          // actions that need a server-side note (public links) meanwhile.
          await markNotePendingCreate(db, clientId);
          return { note: localNote, labelCreates };
        },
        op: ({ note: localNote, labelCreates }) => [
          ...labelCreates,
          {
            operation: 'create',
            endpoint: apiPaths.notes,
            method: 'POST',
            keys: [noteKey(clientId), ...localNote.labels.map((l) => labelKey(l.id))],
            // Carry the pre-assigned item IDs so the server keeps them (no
            // reconciliation) and the local rows stay valid for any per-item
            // edit queued behind this create (#513).
            body: {
              ...data,
              ...(itemsWithIds ? { items: itemsWithIds } : {}),
              id: clientId,
            } as Record<string, unknown>,
          },
        ],
      });
      return note;
    },
    onSuccess: (_note, data) => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // A create can carry labels (the sync-failure fork does), which the new
      // note then counts towards.
      if (data.labels?.length) {
        invalidateLabelList(queryClient);
      }
    },
  });
}

interface UpdateNoteVariables {
  id: string;
  data: UpdateNoteRequest;
  /** Version of the text the user edited from; see the editor's `savedVersionRef`. */
  baseVersion?: number | undefined;
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    onMutate: async ({ id, data }: UpdateNoteVariables) => {
      // Cancel in-flight note reads before patching the cache, so a refetch
      // already on the wire can't resolve over the optimistic edit.
      await cancelNoteReads(queryClient, id);
      const now = new Date().toISOString();
      return applyOptimisticNote(queryClient, id, (note) => ({ ...note, ...data, updated_at: now }));
    },
    mutationFn: async ({ id, data, baseVersion }: UpdateNoteVariables): Promise<Note> => {
      assertSwitchWriteAllowed();
      // Only content edits (title/content) are version-guarded; per-user fields
      // (color/pinned/archived/collapsed) live in note_user_state and aren't.
      const touchesContent = patchTouchesSharedContent(data);
      const now = new Date().toISOString();

      // Through the outbox (#1284): the edit and its queue row commit together,
      // and the drain sends it. A rejection surfaces later as a failed change.
      return enqueueWrite(db, {
        localApply: async () => {
          const existing = await requireLocalNote(db, id);
          await updateLocalNote(db, id, data);
          // The version the edit was made against: the one the editor's text is
          // based on (`baseVersion`), since the row may already hold a
          // collaborator's newer snapshot the user never saw (#1277). Callers
          // without an editor baseline fall back to the row. Either is advanced
          // past this device's own edits that landed since (ownVersions.ts), so
          // a dirty editor does not conflict with its own earlier save.
          const guardVersion = touchesContent
            ? resolveOwnBaseVersion(db, id, baseVersion ?? existing.version)
            : undefined;
          // The editor adopts the returned version as its baseline for a content
          // save; keep the caller's otherwise (#1277).
          return { ...existing, ...data, version: guardVersion ?? baseVersion ?? existing.version, updated_at: now } as Note;
        },
        // Queue only the fields the user actually changed. The server PATCH is a
        // partial update (absent fields are left unchanged), so sending the full
        // snapshot would re-assert stale values and clobber fields edited
        // concurrently on another device when this op replays later.
        op: (note) => ({
          operation: 'update',
          endpoint: apiPaths.note(id),
          method: 'PATCH',
          keys: [noteKey(id)],
          body: (touchesContent ? { ...data, base_version: note.version } : data) as Record<string, unknown>,
        }),
      });
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
      if (data.archived !== undefined) invalidateLabelList(queryClient);
    },
  });
}

/**
 * Thrown by `buildConvertNoteTypeRequest` when a text→list conversion would
 * exceed an item cap the server enforces. Thrown inside the convert's outbox
 * transaction, before anything is written, so a note that would be rejected
 * never reaches the sync queue in the first place — the drain would otherwise
 * report it later as a failed change with no way to explain why.
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

/**
 * Computes the precomputed `content`/`title`/`items` for converting `note` to
 * the opposite type, via the same shared transform
 * (`textToListNote`/`listToText`) the webapp uses — the server only validates
 * and persists whatever is sent (issue #676). Converting to a list promotes a
 * leading heading in the content into the list's title, the inverse of the
 * `# Title` line `listToText` writes in the other direction. Item ids are
 * generated here (rather than left for the server) so a per-item mutation
 * queued right after the convert, before it drains, can target the same id
 * the eventual server row will have (mirrors useDuplicateNote's
 * client-supplied item ids). Excludes `base_version`, which useConvertNoteType
 * adds.
 */
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
      // mirrors that reconstruction so the local result matches.
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
    // A text note has no title, items or collapsed flag: drop the list's, so
    // the cached note matches what SQLite stored.
    const converted: TextNote & Partial<Pick<ListNote, 'title' | 'items' | 'checked_items_collapsed'>> = {
      ...note,
      note_type: 'text',
      content: data.content ?? '',
      updated_at: now,
    };
    delete converted.title;
    delete converted.items;
    delete converted.checked_items_collapsed;
    return converted;
  }
  // Mirrors the server's buildItems (server/internal/notesvc): an item sent with indent_level 1
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

  return useMutation({
    mutationFn: async ({ id, baseVersion }: { id: string; baseVersion?: number | undefined }): Promise<Note> => {
      assertSwitchWriteAllowed();
      const now = new Date().toISOString();
      // Through the outbox (#1285). A cap violation throws inside the
      // transaction, so nothing is written or queued.
      const { note } = await enqueueWrite(db, {
        localApply: async () => {
          const existing = await requireLocalNote(db, id);
          const data = buildConvertNoteTypeRequest(existing);
          // Version-guarded like a content save: the version the editor's text
          // is based on, advanced past this device's own edits that have landed
          // since (ownVersions.ts); the drain rebases it like one too.
          const guardVersion = resolveOwnBaseVersion(db, id, baseVersion ?? existing.version);
          const converted = applyConvertedNoteLocally(existing, data, now);
          await saveNoteInTx(db, converted);
          return { note: converted, data, guardVersion };
        },
        op: ({ data, guardVersion }) => ({
          operation: 'convertNoteType',
          endpoint: apiPaths.noteConvert(id),
          method: 'POST',
          keys: [noteKey(id)],
          body: { ...data, base_version: guardVersion } satisfies ConvertNoteTypeRequest as unknown as Record<string, unknown>,
        }),
      });
      return note;
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
// other devices' changes instead of overwriting them. Each one goes through
// the outbox (#1285): the local edit and its queue row commit together.

export function useCreateNoteItem() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ noteId, item }: { noteId: string; item: CreateNoteItemRequest }): Promise<void> => {
      assertSwitchWriteAllowed();
      // Ensure a stable, server-format ID up front so the local row and the
      // queued op reference the same item (the SQLite insert must never
      // receive an undefined id). This id is also what makes a replay
      // idempotent: if a transient failure hides a create the server actually
      // committed, replaying it POSTs the same id, the server rejects the
      // duplicate with 409 (ErrNoteItemExists), and drainQueue treats that 409
      // as already applied instead of creating a second item.
      const itemWithId: CreateNoteItemRequest = { ...item, id: item.id ?? generateId() };
      await enqueueWrite(db, {
        localApply: () => createLocalItem(db, noteId, {
          id: itemWithId.id!, // set just above
          text: itemWithId.text,
          completed: itemWithId.completed ?? false,
          position: itemWithId.position,
          parent_id: itemWithId.parent_id ?? null,
          assigned_to: itemWithId.assigned_to ?? '',
        }),
        op: () => ({
          operation: 'createItem',
          endpoint: apiPaths.noteItems(noteId),
          method: 'POST',
          keys: [noteKey(noteId)],
          body: itemWithId as unknown as Record<string, unknown>,
        }),
      });
    },
    onSuccess: (_data, { noteId }) => invalidateNoteReads(queryClient, noteId),
  });
}

export function useUpdateNoteItem() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ noteId, itemId, data }: { noteId: string; itemId: string; data: PatchNoteItemRequest }): Promise<void> => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: () => patchLocalItem(db, noteId, itemId, data),
        op: () => ({
          operation: 'updateItem',
          endpoint: apiPaths.noteItem(noteId, itemId),
          method: 'PATCH',
          keys: [noteKey(noteId)],
          body: data as Record<string, unknown>,
        }),
      });
    },
    onSuccess: (_data, { noteId }) => invalidateNoteReads(queryClient, noteId),
  });
}

export function useDeleteNoteItem() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ noteId, itemId }: { noteId: string; itemId: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: () => deleteLocalItem(db, noteId, itemId),
        op: () => ({
          operation: 'deleteItem',
          endpoint: apiPaths.noteItem(noteId, itemId),
          method: 'DELETE',
          keys: [noteKey(noteId)],
        }),
      });
    },
    onSuccess: (_data, { noteId }) => invalidateNoteReads(queryClient, noteId),
  });
}

export function useReorderNoteItems() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }): Promise<void> => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: () => reorderLocalItems(db, noteId, itemIds),
        op: () => ({
          operation: 'reorderItems',
          endpoint: apiPaths.noteItemsReorder(noteId),
          method: 'POST',
          keys: [noteKey(noteId)],
          body: { item_ids: itemIds } satisfies ReorderNoteItemsRequest,
        }),
      });
    },
    onSuccess: (_data, { noteId }) => invalidateNoteReads(queryClient, noteId),
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: () => markLocalNoteDeleted(db, id),
        op: () => ({
          operation: 'delete',
          endpoint: apiPaths.note(id),
          method: 'DELETE',
          keys: [noteKey(id)],
        }),
      });
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // Trashing drops the note out of its labels' counts.
      invalidateLabelList(queryClient);
    },
  });
}

export function useDuplicateNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async (id: string): Promise<Note> => {
      assertSwitchWriteAllowed();
      // The copy gets a server-valid client ID, sent in the request body so the
      // server keeps it — making a replay idempotent (same ID → 409, treated as
      // already applied, no second copy; #1278).
      const clientId = generateClientNoteId();
      const now = new Date().toISOString();
      const { note } = await enqueueWrite(db, {
        localApply: async () => {
          const source = await requireLocalNote(db, id);
          // Source → copy item IDs, also sent to the server so it honors them:
          // per-item edits queued after this duplicate but before it drains
          // still target valid server item IDs.
          const idRemap = new Map<string, string>();
          for (const item of source.note_type === 'list' ? (source.items ?? []) : []) {
            idRemap.set(item.id, generateId());
          }
          const resetFields = {
            id: clientId,
            // The server's copy starts at version 1 like any new note (spec §8.1:
            // the row's version is the server version of its content).
            version: 1,
            pinned: false,
            archived: false,
            position: 0,
            is_shared: false,
            shared_with: [] as NoteShare[],
            // A copy never inherits the source's public link (#1135).
            public_link: null,
            deleted_at: null as string | null,
            created_at: now,
            updated_at: now,
          };
          const localDuplicate: Note = source.note_type === 'list'
            ? {
                ...source,
                ...resetFields,
                items: (source.items ?? []).map((item) => ({
                  ...item,
                  id: idRemap.get(item.id) ?? generateId(),
                  note_id: clientId,
                  parent_id: item.parent_id !== null ? (idRemap.get(item.parent_id) ?? item.parent_id) : null,
                  created_at: now,
                  updated_at: now,
                })),
              }
            : { ...source, ...resetFields };
          await saveNoteInTx(db, localDuplicate);
          await markNotePendingCreate(db, clientId);
          return { note: localDuplicate, idRemap };
        },
        op: ({ idRemap }) => {
          // Assigned field by field, not spread: a spread key is not checked
          // against the request type, so a renamed `item_ids` would still compile.
          const body: DuplicateNoteRequest = { id: clientId };
          if (idRemap.size > 0) body.item_ids = Object.fromEntries(idRemap);
          return {
            operation: 'duplicate',
            endpoint: apiPaths.noteDuplicate(id),
            method: 'POST',
            keys: [noteKey(clientId)],
            // The server copies the source, so its queued writes must land first;
            // the duplicate does not write it.
            readKeys: [noteKey(id)],
            body: body as Record<string, unknown>,
          };
        },
      });
      return note;
    },
    onSuccess: (duplicatedNote) => {
      queryClient.setQueryData(noteLocalQueryKey(duplicatedNote.id), duplicatedNote);
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // The copy keeps the source's labels, so each of them gains a note.
      if (duplicatedNote.labels.length > 0) invalidateLabelList(queryClient);
    },
  });
}

export function useRestoreNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: () => markLocalNoteRestored(db, id),
        op: () => ({
          operation: 'restore',
          endpoint: apiPaths.noteRestore(id),
          method: 'POST',
          keys: [noteKey(id)],
        }),
      });
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // Restoring puts the note back into its labels' counts.
      invalidateLabelList(queryClient);
    },
  });
}

/**
 * Record that the user opened a note, clearing its unread badge. The local
 * clear is authoritative for this device; the queued ping clears it everywhere
 * else. Callers only invoke this for an unread note, so an ordinary open costs
 * no write.
 */
export function useMarkNoteViewed() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      // Best-effort: a view landing mid-switch would mark the wrong server's
      // note, and the badge it leaves behind is harmless.
      if (isServerSwitchInProgress()) return;
      // When the user looked at the note. The ping is sent later, and the
      // server must not count a collaborator's change made in between as seen.
      const viewedAt = new Date().toISOString();
      await enqueueWrite(db, {
        localApply: () => clearLocalNoteUnread(db, id),
        op: () => ({
          operation: 'markViewed',
          endpoint: apiPaths.noteViewed(id),
          method: 'POST',
          keys: [noteKey(id)],
          body: { viewed_at: viewedAt } satisfies MarkNoteViewedRequest,
        }),
      });
    },
    // The SQLite-backed queries never refetch on their own.
    onSettled: (_data, _error, id) => invalidateNoteReads(queryClient, id),
  });
}

export function usePermanentDeleteNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      assertSwitchWriteAllowed();
      // The queued-upload files go only once the transaction has committed:
      // a rollback restores the rows that point at them.
      const uploadFiles = await enqueueWrite(db, {
        localApply: () => permanentDeleteLocalNoteRows(db, id),
        op: () => ({
          operation: 'permanentDelete',
          endpoint: apiPaths.notePermanentDelete(id),
          method: 'DELETE',
          keys: [noteKey(id)],
        }),
      });
      deleteUploadFiles(uploadFiles);
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

  return useMutation({
    mutationFn: async (noteIds: string[]): Promise<void> => {
      assertSwitchWriteAllowed();
      // The new positions commit with the queued reorder (#1285). The list
      // query is SQLite-backed, so any invalidation after this point (the
      // queue drain, an unrelated SSE update) re-reads the new order, not the
      // pre-drag one (#945). The reorder is keyed by every note it names, so it
      // waits behind their queued writes, a pending create included (#956):
      // the server rejects a reorder naming a note it does not know yet.
      await enqueueWrite(db, {
        localApply: async () => {
          for (const [i, noteId] of noteIds.entries()) {
            await updateLocalNote(db, noteId, { position: i });
          }
        },
        op: () => ({
          operation: 'reorder',
          endpoint: apiPaths.notesReorder,
          method: 'POST',
          keys: noteIds.map(noteKey),
          body: { note_ids: noteIds } satisfies ReorderNotesRequest,
        }),
      });
    },
    onMutate: async (noteIds: string[]) => {
      // Cancel in-flight list reads before re-sorting the cache, so a refetch
      // already on the wire can't resolve over the optimistic order.
      await queryClient.cancelQueries({ queryKey: notesLocalQueryScopeKey() });
      return applyOptimisticReorder(queryClient, noteIds);
    },
    // Only a local failure reaches here: the transaction rolled back, so the
    // rows still hold the pre-drag order.
    onError: (_err, _noteIds, snapshot) => {
      if (snapshot) rollbackOptimisticReorder(queryClient, snapshot);
    },
    // Reconcile with the real local DB after either outcome: a rollback
    // restores the snapshot captured at onMutate time, which another mutation
    // may have overtaken since.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
    },
  });
}

export function useNoteShares(noteId: string | null) {
  const { data: note, isLoading, isError } = useOfflineNote(noteId);
  return {
    data: note?.shared_with,
    // The note's owner, so the share screen can tell an owner (full management)
    // from a collaborator (read-only view + leave). Undefined until the note is
    // loaded; the screen treats an unknown owner as the owner-mode default.
    ownerId: note?.user_id,
    // The note's cached public link, kept current by SSE `note_updated` events.
    publicLink: note?.public_link,
    isLoading,
    isError,
  };
}

export function useShareNote() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();

  return useMutation({
    mutationFn: async ({ noteId, user }: { noteId: string; user: UserInfo }) => {
      assertSwitchWriteAllowed();
      // An optimistic share row until the drain lands the share and re-reads
      // the note's shares (the endpoint returns 204), which brings the
      // server-assigned share id.
      await enqueueWrite(db, {
        localApply: async () => {
          const note = await requireLocalNote(db, noteId);
          const existing = note.shared_with ?? [];
          if (existing.some((s) => s.shared_with_user_id === user.id)) return;
          const now = new Date().toISOString();
          const optimisticShare: NoteShare = {
            id: `optimistic_${user.id}`,
            note_id: noteId,
            shared_with_user_id: user.id,
            shared_by_user_id: currentUser?.id ?? '',
            username: user.username,
            first_name: user.first_name,
            last_name: user.last_name,
            has_profile_icon: user.has_profile_icon,
            created_at: now,
            updated_at: now,
          };
          await saveNoteInTx(db, { ...note, is_shared: true, shared_with: [...existing, optimisticShare] });
        },
        op: () => ({
          operation: 'share',
          endpoint: apiPaths.noteShare(noteId),
          method: 'POST',
          keys: [noteKey(noteId)],
          body: { user_id: user.id } satisfies ShareNoteRequest,
        }),
      });
    },
    onSuccess: (_data, { noteId }) => {
      // Invalidating the notes list too re-renders dashboard collaborator avatars.
      invalidateNoteReads(queryClient, noteId);
    },
  });
}

export function useUnshareNote() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ noteId, userId }: { noteId: string; userId: string }) => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: async () => {
          const note = await requireLocalNote(db, noteId);
          const remaining = (note.shared_with ?? []).filter((s) => s.shared_with_user_id !== userId);
          await saveNoteInTx(db, { ...note, is_shared: remaining.length > 0, shared_with: remaining });
        },
        op: () => ({
          operation: 'unshare',
          endpoint: apiPaths.noteShareUser(noteId, userId),
          method: 'DELETE',
          keys: [noteKey(noteId)],
        }),
      });
    },
    onSuccess: (_data, { noteId }) => {
      // Invalidating the notes list too re-renders dashboard collaborator avatars.
      invalidateNoteReads(queryClient, noteId);
    },
  });
}

/**
 * Leave a note shared with the current user. This is the collaborator side of
 * unsharing: it hits the same `DELETE /notes/{id}/shares/{user_id}` endpoint an
 * owner uses to remove a collaborator, but targeting the current user's own
 * share (the server allows a non-owner to remove only themselves).
 *
 * The difference from {@link useUnshareNote} is the local effect: an owner
 * dropping a collaborator keeps the note and just prunes a `shared_with` row,
 * whereas a collaborator who leaves loses access entirely, so the note must be
 * removed from the local DB and disappear from their list — not left behind
 * holding a stale copy the server will never refresh again.
 */
export function useLeaveNote() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();

  return useMutation({
    mutationFn: async ({ noteId }: { noteId: string }) => {
      assertSwitchWriteAllowed();
      const userId = currentUser?.id;
      if (!userId) throw new Error('Cannot leave a note without a signed-in user');

      // Remove the note locally and queue the self-removal. The queued op
      // reuses `unshare` — the endpoint and method are identical, it is
      // treated as idempotent when the target is gone
      // (GONE_IDEMPOTENT_OPERATIONS), and its drain tolerates the follow-up GET
      // returning 403 for a note the user no longer has access to. A rejection
      // has nothing local to attach to, so the drain resolves it by pulling the
      // note, which brings it back if the server kept the share (#1285).
      const uploadFiles = await enqueueWrite(db, {
        localApply: async () => {
          await requireLocalNote(db, noteId);
          return permanentDeleteLocalNoteRows(db, noteId);
        },
        op: () => ({
          operation: 'unshare',
          endpoint: apiPaths.noteShareUser(noteId, userId),
          method: 'DELETE',
          keys: [noteKey(noteId)],
        }),
      });
      // Only once committed, as in usePermanentDeleteNote.
      deleteUploadFiles(uploadFiles);
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.removeQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      // The note drops out of any labels the user had applied to it locally.
      invalidateLabelList(queryClient);
    },
  });
}

export function useToggleNoteItemCompleted() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  return useMutation({
    onMutate: async ({ noteId, itemId, completed }: { noteId: string; itemId: string; completed: boolean }) => {
      await cancelNoteReads(queryClient, noteId);
      applyOptimisticNote(queryClient, noteId, (note) =>
        note.note_type === 'list' && note.items
          ? { ...note, items: applyToggleToItems(note.items, itemId, completed) }
          : note,
      );
    },
    // Resolves to every id SQLite now holds at `completed`: the cascade as
    // the stored hierarchy scopes it, which can lag the editor's own (an
    // indent not yet saved), so the editor marks only these ids as saved.
    mutationFn: async ({ noteId, itemId, completed }: { noteId: string; itemId: string; completed: boolean }): Promise<string[]> => {
      assertSwitchWriteAllowed();
      return enqueueWrite(db, {
        localApply: async () => {
          const note = await getLocalNote(db, noteId);
          const items = note?.note_type === 'list' && note.items ? note.items : [];
          // Every changed id is one whose value actually flips, so the whole
          // set moves in one grouped write — no window where a re-read can
          // catch a parent checked but its children not. The op names only the
          // tapped item; the server applies the same cascade.
          await setLocalItemsCompleted(db, noteId, collectToggleCascade(items, itemId, completed), completed);
          return completedCascadeScope(items.map((i) => ({ id: i.id, parentId: i.parent_id })), itemId, completed);
        },
        op: () => ({
          operation: 'setItemsCompleted',
          endpoint: apiPaths.noteItemsSetCompleted(noteId),
          method: 'POST',
          keys: [noteKey(noteId)],
          body: { item_ids: [itemId], completed } satisfies SetNoteItemsCompletedRequest,
        }),
      });
    },
    // Re-read either way: after a local failure the rolled-back rows replace
    // the optimistic cache.
    onSettled: (_data, _err, { noteId }) => invalidateNoteReads(queryClient, noteId),
  });
}

/**
 * Bulk-uncheck a caller-supplied set of item ids (the note's currently
 * completed items, captured at action time): useToggleNoteItemCompleted over a
 * set of ids instead of a single item with cascade.
 */
export function useUncheckAllItems() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  return useMutation({
    onMutate: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }) => {
      await cancelNoteReads(queryClient, noteId);
      applyOptimisticNote(queryClient, noteId, (note) =>
        note.note_type === 'list' && note.items
          ? { ...note, items: applySetCompletedToItems(note.items, itemIds, false) }
          : note,
      );
    },
    // Resolves to the ids it unchecked, as the toggle does.
    mutationFn: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }): Promise<string[]> => {
      assertSwitchWriteAllowed();
      if (itemIds.length === 0) return [];
      return enqueueWrite(db, {
        localApply: async () => {
          await setLocalItemsCompleted(db, noteId, itemIds, false);
          return itemIds;
        },
        // Carries the exact ids captured at click time.
        op: () => ({
          operation: 'setItemsCompleted',
          endpoint: apiPaths.noteItemsSetCompleted(noteId),
          method: 'POST',
          keys: [noteKey(noteId)],
          body: { item_ids: itemIds, completed: false } satisfies SetNoteItemsCompletedRequest,
        }),
      });
    },
    onSettled: (_data, _err, { noteId }) => invalidateNoteReads(queryClient, noteId),
  });
}

/**
 * Bulk-delete a caller-supplied set of item ids (the note's currently
 * completed items, captured at action time). Deleting exactly the completed
 * set never orphans a child: the completed-cascade invariant
 * (applyCompletedCascade / collectToggleCascade) guarantees a completed
 * parent's children are completed too, so they are always included in the
 * same delete.
 */
export function useDeleteCompletedItems() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  return useMutation({
    // Cancelling in-flight reads keeps a refetch already on the wire from
    // resolving over the optimistic removal.
    onMutate: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }) => {
      await cancelNoteReads(queryClient, noteId);
      return applyOptimisticNote(queryClient, noteId, (note) => {
        if (note.note_type !== 'list' || !note.items) return note;
        const ids = new Set(itemIds);
        return { ...note, items: note.items.filter((item) => !ids.has(item.id)) };
      });
    },
    mutationFn: async ({ noteId, itemIds }: { noteId: string; itemIds: string[] }): Promise<void> => {
      assertSwitchWriteAllowed();
      if (itemIds.length === 0) return;
      // One bulk op carrying the exact ids captured at click time.
      await enqueueWrite(db, {
        localApply: () => deleteLocalItems(db, noteId, itemIds),
        op: () => ({
          operation: 'deleteCompletedItems',
          endpoint: apiPaths.noteItemsDelete(noteId),
          method: 'POST',
          keys: [noteKey(noteId)],
          body: { item_ids: itemIds } satisfies DeleteNoteItemsRequest,
        }),
      });
    },
    // Only a local failure reaches here; the transaction rolled back.
    onError: (_err, { noteId }, context) => rollbackOptimisticNote(queryClient, noteId, context),
    onSuccess: (_data, { noteId }) => invalidateNoteReads(queryClient, noteId),
  });
}

// Re-export for convenience in screens that want explicit local-DB backed queries
export { saveNotes };
