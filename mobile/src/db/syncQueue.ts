import { SQLiteDatabase } from 'expo-sqlite';
import axios from 'axios';
import api from '../api/client';
import type { GetNotesParams, Note, NoteItem } from '@jot/shared';
import {
  saveNote,
  saveNotes,
  saveLabels,
  patchLocalItem,
  reconcileServerNotesScope,
  markNoteSyncFailed,
  clearNoteSyncFailed,
  clearNotePendingCreate,
  getFailedNoteIds,
  getLocalNoteVersion,
  setLocalNoteVersion,
  updateLocalNoteShares,
} from './noteQueries';
import { isLocalModeActive } from '../store/localMode';
import type { Label } from '@jot/shared';

export type QueueOperation =
  | 'create'
  | 'duplicate'
  | 'update'
  | 'convertNoteType'
  | 'delete'
  | 'restore'
  | 'permanentDelete'
  | 'reorder'
  | 'createItem'
  | 'updateItem'
  | 'deleteItem'
  | 'reorderItems'
  | 'toggleItemCompleted'
  | 'share'
  | 'unshare'
  | 'createLabel'
  | 'renameLabel'
  | 'deleteLabel'
  | 'addLabelToNote'
  | 'removeLabelFromNote'
  | 'updateSettings'
  | 'removeImage';

interface QueueEntry {
  id: number;
  operation: QueueOperation;
  endpoint: string;
  method: string;
  body: string | null;
  created_at: string;
  /**
   * Count of transient drain failures for this specific entry (issue #714).
   * Defaults to 0 for rows written before migration 6 / by older code paths.
   */
  attempts?: number;
}

/**
 * How many times a single queue entry may fail transiently before it is
 * dead-lettered and the drain continues past it (issue #714). A persistently
 * 5xx-ing op, or one whose processing throws a non-HTTP error, would otherwise
 * sit at the FIFO head forever and block every later write.
 *
 * Kept below OfflineContext's MAX_CONSECUTIVE_DRAIN_FAILURES so the backoff
 * retries within a single online session are enough to walk a poison entry to
 * its cap and unwedge the queue before the scheduler pauses auto-retries.
 * The counter also persists across reconnects/restarts, so even a paused
 * scheduler resumes the walk on the next external trigger.
 */
export const MAX_ENTRY_DRAIN_ATTEMPTS = 5;

/** dead_letter.status sentinel for a non-HTTP local processing error (issue #714). */
export const PROCESSING_ERROR_STATUS = 0;

export interface EnqueueParams {
  operation: QueueOperation;
  endpoint: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
}

/**
 * Whether an HTTP status (or `undefined`, meaning no response — a network
 * failure or timeout) represents a *transient* failure that is worth retrying
 * later, as opposed to a *permanent* one that will never succeed on replay.
 *
 * Transient: network errors (no response), request timeout (408), rate limiting
 * (429), session expiry that may recover after re-auth (401), and server errors
 * (5xx). Everything else — notably 4xx client errors such as validation
 * (400/422), forbidden (403), and missing/conflict (404/409) — is permanent.
 *
 * Shared by two call sites so they stay in agreement:
 *   - online writes (useNotes): transient → fall back to the local queue instead
 *     of losing the edit; permanent → surface the error to the UI.
 *   - queue drain: transient → stop draining and retry on the next reconnect;
 *     permanent → discard (dead-letter) the entry so it cannot wedge the queue.
 */
export function isTransientHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 401 || status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * Of the *transient* failures, which ones block the whole queue rather than
 * being specific to the entry at the head (issue #714)? A global failure stops
 * the drain without charging the entry's attempt counter — every entry would
 * fail the same way — whereas an entry-specific transient failure walks that
 * entry toward being dead-lettered so it can't wedge the head forever.
 *
 * Global: a transport-level failure with no server response (network down or a
 * client timeout), plus statuses that apply queue-wide (401 needs re-auth, 408
 * request timeout, 429 rate limit). Entry-specific: a 5xx tied to this op's
 * payload, and any non-HTTP error thrown while processing the entry itself
 * (corrupted body, a local DB error) — those are charged and eventually
 * dead-lettered.
 */
export function isGlobalDrainFailure(err: unknown, status: number | undefined): boolean {
  // A non-HTTP error thrown while processing an entry is specific to that entry.
  if (!axios.isAxiosError(err)) return false;
  // Transport-level failure with no server response: network down or timeout.
  if (err.response === undefined) return true;
  // Statuses that block the whole queue regardless of the specific entry.
  return status === 401 || status === 408 || status === 429;
}

/**
 * Operations for which a "target is gone" replay status (404/410) is an
 * idempotent success rather than a failure to preserve. These are destructive /
 * state-transition ops whose desired end-state (the note/item/share/label is
 * gone, or the note is restored) is *already true* once the target no longer
 * exists, and which carry no local content the "Keep my version" note-fork
 * recovery (useSyncFailures) could meaningfully rescue — so dead-lettering them
 * would only surface a spurious "couldn't be saved" banner (and, for a delete,
 * offer to resurrect the note the user just deleted).
 *
 * This is the common flaky-connection case: an online write times out
 * client-side (WRITE_REQUEST_TIMEOUT_MS, see api/client.ts) *after* the server
 * committed it, falls back to the offline queue, and the replay then finds the
 * note already trashed/restored/gone (server returns 404). Mirrors the
 * long-standing `removeImage` handling below, generalized to its siblings.
 */
const GONE_IDEMPOTENT_OPERATIONS: ReadonlySet<QueueOperation> = new Set([
  'delete',
  'permanentDelete',
  'restore',
  'deleteItem',
  'unshare',
  'removeLabelFromNote',
  'deleteLabel',
]);

/**
 * Returns true if the error is a transient HTTP failure that can be safely
 * swallowed and queued for later replay. Returns false for permanent errors
 * (non-Axios errors, 401, or permanent 4xx) that should be surfaced.
 *
 * 401 is treated as non-queueable: the API response interceptor clears the
 * session on 401, so the write must surface the error rather than queue it.
 */
export function isQueueableError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  return status !== 401 && isTransientHttpStatus(status);
}

/**
 * Called from the `catch` of an online write attempt. If the failure is
 * transient (a flaky connection, timeout, or 5xx), it is swallowed so the
 * caller can fall back to the offline path — writing locally and queueing the
 * operation for replay — instead of losing the edit. Permanent failures (4xx
 * validation/auth/conflict) and unexpected local errors are rethrown so the UI
 * can surface them to the user.
 */
export function rethrowIfNotQueueable(err: unknown): void {
  if (!isQueueableError(err)) {
    throw err;
  }
}

type EnqueueListener = () => void;

const enqueueListeners = new Set<EnqueueListener>();

/**
 * Subscribe to be notified whenever an operation is appended to the sync queue.
 * Lets the offline layer kick off a drain right after a write is queued, instead
 * of waiting for an offline→online transition. Returns an unsubscribe function.
 */
export function subscribeToEnqueue(listener: EnqueueListener): () => void {
  enqueueListeners.add(listener);
  return () => {
    enqueueListeners.delete(listener);
  };
}

/**
 * Notify enqueue listeners directly, bypassing `enqueueOperation`. Used by
 * imageUploadQueue.ts, whose offline upload queue is a separate table (a
 * multipart file upload doesn't fit the JSON `sync_queue` row shape) but
 * still wants to trigger OfflineContext's debounced drain like any other
 * freshly-queued write (issue #618).
 */
export function notifyEnqueueListeners(): void {
  for (const listener of enqueueListeners) {
    try {
      listener();
    } catch (err) {
      console.warn('Enqueue listener failed:', err);
    }
  }
}

/**
 * Insert a single entry directly into the sync queue, bypassing the local-mode
 * guard and enqueue listeners. Used exclusively by the local→server upgrade seed
 * path (seedReplayQueue): local mode is still active while the queue is being
 * pre-populated for replay, so the normal `enqueueOperation` guard would be a
 * no-op. Do NOT call this from any other code path.
 */
export async function insertQueueEntry(db: SQLiteDatabase, params: EnqueueParams): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      params.operation,
      params.endpoint,
      params.method,
      params.body ? JSON.stringify(params.body) : null,
      new Date().toISOString(),
    ],
  );
}

export async function enqueueOperation(db: SQLiteDatabase, params: EnqueueParams): Promise<void> {
  // Local mode has no server to sync to, so local writes are terminal the moment
  // they land in SQLite (issue #514). Short-circuit before touching `sync_queue`
  // so no ops ever accumulate there — and, by extension, nothing can dead-letter
  // purely because a server is absent. The drain loop is also gated off in local
  // mode (OfflineContext), so a stray queued op would otherwise sit pending forever.
  if (isLocalModeActive()) {
    return;
  }
  await insertQueueEntry(db, params);
  notifyEnqueueListeners();
}

export async function getPendingCount(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM sync_queue');
  return row?.count ?? 0;
}

/** Head-of-line diagnostics for the sync queue (issue #714). */
export interface SyncQueueStats {
  pendingCount: number;
  /**
   * The oldest pending entry — the FIFO head that a wedge blocks on — or null
   * when the queue is empty. `attempts` shows how many times draining it has
   * failed transiently (approaching MAX_ENTRY_DRAIN_ATTEMPTS = dead-letter).
   */
  head: { id: number; operation: QueueOperation; created_at: string; attempts: number } | null;
  /** Highest attempt count across all pending entries. */
  maxAttempts: number;
}

/**
 * Summarize the sync queue for the Diagnostics screen so a head-of-line wedge is
 * legible: which op is stuck at the head, how old it is, and how many transient
 * failures it (or any entry) has racked up (issue #714). A pending count alone
 * can't distinguish "healthy backlog" from "one poison entry blocking the rest".
 */
export async function getSyncQueueStats(db: SQLiteDatabase): Promise<SyncQueueStats> {
  const head = await db.getFirstAsync<{
    id: number;
    operation: QueueOperation;
    created_at: string;
    attempts: number | null;
  }>('SELECT id, operation, created_at, attempts FROM sync_queue ORDER BY id ASC LIMIT 1');
  const pendingCount = await getPendingCount(db);
  const maxRow = await db.getFirstAsync<{ max: number | null }>('SELECT MAX(attempts) as max FROM sync_queue');
  return {
    pendingCount,
    head: head
      ? { id: head.id, operation: head.operation, created_at: head.created_at, attempts: head.attempts ?? 0 }
      : null,
    maxAttempts: maxRow?.max ?? 0,
  };
}

function parseQueueBody(body: string | null): Record<string, unknown> | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Add the note IDs touched by a single queued op (identified by its endpoint and
 * already-parsed body) to `ids`. Note IDs are recovered from the endpoint shapes
 * enqueued by useNotes/useLabels (see the per-branch comments below). Label-only
 * endpoints (/labels/…) aren't tied to a single note and contribute nothing.
 */
function collectNoteIds(
  endpoint: string,
  body: Record<string, unknown> | null,
  ids: Set<string>,
): void {
  // Drop any query string (e.g. "/notes/{id}?permanent=true") before splitting,
  // and filter out the empty segment from the leading slash.
  const segments = endpoint.split('?')[0].split('/').filter(Boolean);
  if (segments[0] === 'images') {
    // DELETE /images/{id}: the endpoint has no note id in it, so `removeImage`
    // ops (see useNoteImages.ts) carry it in the body purely for this
    // bookkeeping — it is never sent to the server (DELETE has no body).
    const noteId = body?.note_id;
    if (typeof noteId === 'string') ids.add(noteId);
    return;
  }
  if (segments[0] !== 'notes') return;

  if (segments.length === 1) {
    // POST /notes (create): the affected note is the offline-created note, identified
    // by the client-supplied `id` (issue #475).
    const createId = body?.id;
    if (typeof createId === 'string') ids.add(createId);
  } else if (segments[1] === 'reorder') {
    // POST /notes/reorder: body.note_ids lists every note whose position moved.
    const noteIds = body?.note_ids;
    if (Array.isArray(noteIds)) {
      for (const id of noteIds) if (typeof id === 'string') ids.add(id);
    }
  } else {
    // POST /notes/{id}/duplicate creates a local clone: the write belongs to the
    // clone, not the source note (which it only reads), so track just the new
    // note id via the client-supplied `id`.
    if (segments.length === 3 && segments[2] === 'duplicate') {
      const dupId = body?.id;
      if (typeof dupId === 'string') ids.add(dupId);
    } else {
      ids.add(segments[1]);
    }
  }
}

/** The note IDs a single queued op touches, as an array (see {@link collectNoteIds}). */
function affectedNoteIds(endpoint: string, body: Record<string, unknown> | undefined): string[] {
  const ids = new Set<string>();
  collectNoteIds(endpoint, body ?? null, ids);
  return [...ids];
}

/**
 * The note IDs a dead-lettered op touched, recovered from its stored (effective)
 * endpoint/body. A multi-note op like `reorder` records its dead_letter row with
 * `note_id = NULL` yet still flags every affected note `sync_state = 'failed'`,
 * so the sync-failure resolution flow uses this to clear all of those per-note
 * badges — not just the single linked note (#493).
 */
export function deadLetterAffectedNoteIds(
  dl: Pick<DeadLetteredOperation, 'endpoint' | 'body'>,
): string[] {
  return affectedNoteIds(dl.endpoint, parseQueueBody(dl.body) ?? undefined);
}

/**
 * Collect the IDs of every note that currently has a pending operation in the
 * sync queue. Server-sourced read paths (background fetch, SSE) consult this set
 * so a fetch of stale server state can't transiently revert an optimistic local
 * edit before its queued op has drained (see issue #487).
 */
export async function getPendingNoteIds(db: SQLiteDatabase): Promise<Set<string>> {
  const entries = await db.getAllAsync<Pick<QueueEntry, 'endpoint' | 'body'>>(
    'SELECT endpoint, body FROM sync_queue',
  );

  const ids = new Set<string>();
  for (const entry of entries) {
    collectNoteIds(entry.endpoint, parseQueueBody(entry.body), ids);
  }
  return ids;
}

/**
 * Notes that server-sourced writes must leave untouched: those with a pending
 * queue op (#487) plus those marked `sync_state = 'failed'` after a dead-lettered
 * op (#492). A dead-lettered note no longer has a queue row, so the failed flag
 * is what keeps its preserved local content from being overwritten or pruned by
 * a later background fetch / SSE event.
 */
export async function getProtectedNoteIds(db: SQLiteDatabase): Promise<Set<string>> {
  const [pending, failed] = await Promise.all([getPendingNoteIds(db), getFailedNoteIds(db)]);
  for (const id of failed) pending.add(id);
  return pending;
}

/**
 * Persist a note fetched from the server (background fetch, SSE, post-import sync),
 * leaving notes with a pending or failed local op untouched (see
 * {@link getProtectedNoteIds} for the rationale, #487/#492). Once the queue drains
 * and any failure is resolved the gate is empty, so the next server fetch or SSE
 * event re-applies canonical server state normally.
 */
export async function saveServerNote(db: SQLiteDatabase, note: Note): Promise<void> {
  await saveNote(db, note, { skipNoteIds: await getProtectedNoteIds(db) });
}

/** Batch counterpart of {@link saveServerNote}; reads the protected set once. */
export async function saveServerNotes(db: SQLiteDatabase, notes: Note[]): Promise<void> {
  await saveNotes(db, notes, { skipNoteIds: await getProtectedNoteIds(db) });
}

/**
 * Labels with an unsynced offline `createLabel` op still queued: their client id
 * *is* the server id (#546), but the create hasn't reached the server yet, so a
 * canonical GET /labels won't list them. They must be protected from pruning
 * when reconciling the label store (see {@link saveServerLabels}).
 */
export async function getPendingLabelIds(db: SQLiteDatabase): Promise<Set<string>> {
  const entries = await db.getAllAsync<Pick<QueueEntry, 'operation' | 'body'>>(
    "SELECT operation, body FROM sync_queue WHERE operation = 'createLabel'",
  );
  const ids = new Set<string>();
  for (const entry of entries) {
    const body = parseQueueBody(entry.body);
    const id = body?.id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/**
 * Persist a canonical server label list into the store (background sync), pruning
 * any local label the server no longer has while leaving unsynced offline-created
 * labels untouched (see {@link getPendingLabelIds}). This is what makes an empty
 * label created/deleted on another device converge locally (issue #691).
 */
export async function saveServerLabels(db: SQLiteDatabase, labels: Label[]): Promise<void> {
  await saveLabels(db, labels, { skipLabelIds: await getPendingLabelIds(db) });
}

/**
 * Reconcile a scoped server note list into local SQLite. Reads the protected-id set
 * once (notes with an unsynced pending/failed local edit, #487/#492) and delegates to
 * {@link reconcileServerNotesScope}, which applies the save and the prune atomically.
 */
export async function saveServerNotesScope(
  db: SQLiteDatabase,
  serverNotes: Note[],
  params?: GetNotesParams,
): Promise<void> {
  const skipNoteIds = await getProtectedNoteIds(db);
  await reconcileServerNotesScope(db, serverNotes, params, { skipNoteIds });
}

function remapValue(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return idMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapValue(item, idMap));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = remapValue(v, idMap);
    }
    return result;
  }
  return value;
}

function remapIdsInBody(
  body: Record<string, unknown>,
  idMap: Map<string, string>,
): Record<string, unknown> {
  if (idMap.size === 0) return body;
  return remapValue(body, idMap) as Record<string, unknown>;
}

/** Narrow an unknown API response to something carrying a string `id` (a note or label). */
function hasStringId(data: unknown): data is { id: string } {
  return data !== null && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string';
}

export interface DiscardedOperation {
  operation: QueueOperation;
  endpoint: string;
  /**
   * The status that caused the discard: a permanent (non-transient 4xx) HTTP
   * status, a transient HTTP status (5xx) that never recovered after
   * MAX_ENTRY_DRAIN_ATTEMPTS tries, or PROCESSING_ERROR_STATUS (0) for a
   * non-HTTP local processing error (issue #714).
   */
  status: number;
}

export interface DrainResult {
  /** The canonical server note returned for each drained create/duplicate operation. */
  idMappings: Array<{ localId: string; serverNote: Note }>;
  /** Operations that were discarded because the server returned a permanent (non-transient 4xx) error. */
  discardedOperations: DiscardedOperation[];
  /** True if at least one `updateSettings` operation was successfully drained. */
  syncedSettings: boolean;
}

/** A dead-lettered op as stored in the `dead_letter` table (see issue #492). */
export interface DeadLetteredOperation {
  id: number;
  operation: QueueOperation;
  endpoint: string;
  method: string;
  body: string | null;
  status: number;
  note_id: string | null;
  created_at: string;
  failed_at: string;
  /** Transient drain attempts made before giving up (0 for a permanent first-try discard); #714. */
  attempts: number;
  /** Last error text, when the discard came from a repeated transient/processing failure (#714). */
  error_message: string | null;
}

/** Read all preserved dead-lettered ops, oldest first. */
export async function getDeadLetteredOperations(db: SQLiteDatabase): Promise<DeadLetteredOperation[]> {
  return db.getAllAsync<DeadLetteredOperation>('SELECT * FROM dead_letter ORDER BY id ASC');
}

/** Count of preserved dead-lettered ops; drives the "N changes couldn't be saved" banner (#493). */
export async function getDeadLetterCount(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM dead_letter');
  return row?.count ?? 0;
}

/**
 * Remove a resolved dead-letter row once the user has chosen how to handle it
 * (kept-as-new or discarded; see issue #493). Clearing the affected note's
 * `sync_state = 'failed'` flag is the caller's responsibility.
 */
export async function deleteDeadLetter(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM dead_letter WHERE id = ?', [id]);
}

/**
 * Preserve a dead-lettered op (its full body + metadata) in the `dead_letter`
 * table so a permanently-rejected optimistic edit is never silently dropped
 * (issue #492). `endpoint`/`body` are the *effective* (id-remapped) values that
 * were actually sent; `noteId` links the row to the affected note when there is
 * a single clear one.
 */
async function recordDeadLetter(
  db: SQLiteDatabase,
  entry: QueueEntry,
  endpoint: string,
  body: Record<string, unknown> | undefined,
  status: number,
  noteId: string | null,
  options?: { attempts?: number; errorMessage?: string | null },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO dead_letter (operation, endpoint, method, body, status, note_id, created_at, failed_at, attempts, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.operation,
      endpoint,
      entry.method,
      body ? JSON.stringify(body) : null,
      status,
      noteId,
      entry.created_at,
      new Date().toISOString(),
      options?.attempts ?? 0,
      options?.errorMessage ?? null,
    ],
  );
}

/**
 * Drain the sync queue in FIFO order. For each entry, make the corresponding API call.
 * On success, delete the entry. On a permanent client error (non-transient 4xx),
 * discard the entry and continue: idempotent 409 conflicts resolve silently, while
 * every other permanent status dead-letters the op (preserved in the `dead_letter`
 * table with the affected note flagged `sync_state = 'failed'`) so the optimistic
 * edit isn't lost (#492).
 *
 * Transient failures split two ways (issue #714):
 *   - *Global* connectivity failures — no server response (network error/timeout)
 *     or a whole-queue-blocking status (401 re-auth, 408, 429 rate-limit) — stop
 *     the drain without charging the head entry, since every entry would fail the
 *     same way; the remainder retries on the next reconnect.
 *   - *Entry-specific* failures — a 5xx tied to this op's payload, or a non-HTTP
 *     error thrown while processing this entry (corrupted body, a local DB error)
 *     — increment the entry's `attempts` counter and stop. Once an entry has
 *     failed MAX_ENTRY_DRAIN_ATTEMPTS times it is dead-lettered and the drain
 *     continues *past* it, so one reproducibly-failing op can no longer wedge the
 *     FIFO head and starve later writes for unrelated notes (the head-of-line
 *     bug). A long server-wide 5xx outage can therefore dead-letter the head after
 *     the cap even though the op was fine — an accepted trade-off: the op is
 *     preserved in dead_letter and recoverable via the failed-changes review flow.
 *
 * Handles offline-create ID reconciliation: when a `create` or `duplicate` operation
 * succeeds, the server echoes back the client-supplied ID unchanged. The canonical
 * server note (with authoritative fields like `updated_at`, version, item IDs) is
 * adopted locally and the pending-create marker is cleared.
 *
 * Returns an array of {localId, serverNote} pairs for any create operations that
 * succeeded, so callers can update their caches.
 */
export async function drainQueue(db: SQLiteDatabase): Promise<DrainResult> {
  const entries = await db.getAllAsync<QueueEntry>(
    'SELECT * FROM sync_queue ORDER BY id ASC',
  );

  // Maps offline label IDs → server IDs as createLabel ops are processed
  const idMap = new Map<string, string>();
  const idMappings: Array<{ localId: string; serverNote: Note }> = [];
  const discardedOperations: DiscardedOperation[] = [];
  // Notes whose offline `create`/`duplicate` was dead-lettered this drain: the
  // note never reached the server, so every later queued op for it would 404 and
  // dead-letter one-by-one (a pile of rows for a single note). Instead we drop
  // those dependents in place — the note is already flagged `failed`, and the
  // "Keep my version" fork rebuilds from the note's *local* content, which still
  // carries the whole chained edit (issue #714 cascade).
  const abandonedCreateNoteIds = new Set<string>();
  let syncedSettings = false;

  for (const entry of entries) {
    // Declared outside the try so the catch can dead-letter using the *effective*
    // (id-remapped) endpoint/body that were actually sent to the server.
    let endpoint = entry.endpoint;
    let body: Record<string, unknown> | undefined;
    try {
      if (entry.body) {
        body = JSON.parse(entry.body) as Record<string, unknown>;
        body = remapIdsInBody(body, idMap);
      }

      // If this op targets a note whose create was just dead-lettered, replaying
      // it against a note the server never got is pointless — drop it (the note
      // stays flagged failed) rather than round-tripping to a guaranteed 404.
      if (abandonedCreateNoteIds.size > 0) {
        const touched = affectedNoteIds(endpoint, body);
        if (touched.length > 0 && touched.every((id) => abandonedCreateNoteIds.has(id))) {
          console.warn(
            `Dropping queued operation id=${entry.id} (${entry.operation}): its note's create was dead-lettered.`,
          );
          await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
          continue;
        }
      }

      // Remap local IDs in the endpoint path, matching only complete path segments
      // to avoid corrupting URLs where the ID appears as a substring.
      for (const [localId, serverId] of idMap) {
        endpoint = endpoint
          .split('/')
          .map((seg) => (seg === localId ? serverId : seg))
          .join('/');
      }

      if (entry.method === 'POST') {
        if (entry.operation === 'convertNoteType' && body) {
          // Resolve base_version from the note's current local version at replay
          // time, matching `update` (#489): a chain of offline edits to one note
          // (e.g. a scalar update followed by a convert) then replays each op
          // against the version the previous one left behind instead of the
          // stale value captured when this op was first queued.
          const noteId = affectedNoteIds(endpoint, body)[0];
          const version = noteId ? await getLocalNoteVersion(db, noteId) : null;
          if (version !== null) body.base_version = version;
        }
        const response = await api.post(endpoint, body);

        if (entry.operation === 'create' || entry.operation === 'duplicate') {
          // The server keeps the client-supplied `id`, so the id is stable —
          // adopt the canonical note (server item ids etc.) and clear the
          // pending-create marker. No id remap is needed.
          const clientId = body?.id as string | undefined;
          const data = response?.data;
          if (clientId && hasStringId(data)) {
            const serverNote = data as Note;
            idMappings.push({ localId: clientId, serverNote });
            await saveNote(db, serverNote);
            await clearNotePendingCreate(db, clientId);
          }
        } else if (entry.operation === 'createLabel' && body?.local_id) {
          // Backward compat: ops queued before issue #546 carried a `local_*`
          // placeholder id that the server replaced with a new server id. Remap
          // so later ops (rename/delete) reference the correct id. New ops carry
          // a client-supplied `id` (the server id) and skip this block entirely.
          const localId = body.local_id as string;
          const data = response?.data;
          if (hasStringId(data) && data.id !== localId) {
            idMap.set(localId, data.id);
          }
        } else if (entry.operation === 'addLabelToNote') {
          // The server returns the updated note; persist it so labels_json
          // reflects the server-assigned label id (replacing any local id).
          await saveNoteFromResponse(db, response?.data);
        } else if (entry.operation === 'toggleItemCompleted') {
          const items = response?.data as NoteItem[] | undefined;
          if (Array.isArray(items) && items.length > 0) {
            // endpoint: /notes/{noteId}/items/{itemId}/toggle-completed
            // The server returns the note's full, authoritative item list (not
            // just the toggled item), so reconcile every field here rather than
            // just `completed` — otherwise a local item left stale by an earlier
            // partial sync (e.g. parent_id/position from a reorder) never gets
            // corrected, and the toggle can end up applied to the wrong item's
            // row once rendered.
            const noteId = endpoint.split('/')[2];
            for (const item of items) {
              await patchLocalItem(db, noteId, item.id, {
                text: item.text,
                completed: item.completed,
                position: item.position,
                parent_id: item.parent_id,
                assigned_to: item.assigned_to,
              });
            }
          }
        } else if (entry.operation === 'share') {
          // Share returns 204 (no body) and the optimistic local note carries a
          // synthetic `optimistic_<userId>` share row; re-fetch the canonical note
          // so shared_with reflects the server-assigned share ids.
          await reconcileNoteFromServer(db, affectedNoteIds(endpoint, body)[0]);
        } else if (entry.operation === 'convertNoteType') {
          // The server returns the full converted note (authoritative version,
          // updated_at, and item ids); persist it rather than trusting the local
          // optimistic apply to still be in sync after other edits may have
          // queued in between.
          await saveNoteFromResponse(db, response?.data);
        }
      } else if (entry.method === 'PATCH') {
        const updateNoteID =
          entry.operation === 'update' ? affectedNoteIds(endpoint, body)[0] : undefined;
        if (updateNoteID !== undefined && body && ('content' in body || 'title' in body)) {
          // Resolve the optimistic-concurrency base from the note's current local
          // version at replay time. setLocalNoteVersion below advances that version
          // after each drained edit, so a chain of offline edits to one note
          // replays against the right base even across separate drains; a note
          // changed on another device keeps its stale local version (it's
          // protected from server overwrite while queued, #487), so a real
          // conflict is still caught (#489).
          const version = await getLocalNoteVersion(db, updateNoteID);
          if (version !== null) body.base_version = version;
        }
        const response = await api.patch(endpoint, body);
        if (entry.operation === 'updateSettings') {
          syncedSettings = true;
        } else if (updateNoteID !== undefined) {
          // Refresh just the local version from the canonical response so the next
          // queued edit to this note resolves a fresh base_version (above).
          const serverNote = response?.data;
          if (hasStringId(serverNote) && typeof (serverNote as Note).version === 'number') {
            await setLocalNoteVersion(db, updateNoteID, (serverNote as Note).version);
          }
        }
      } else if (entry.method === 'DELETE') {
        const response = await api.delete(endpoint);
        if (entry.operation === 'removeLabelFromNote') {
          // The server returns the updated note; persist it so the local
          // labels_json drops the removed label and stays consistent.
          await saveNoteFromResponse(db, response?.data);
        } else if (entry.operation === 'unshare') {
          // Unshare returns 204 (no body); re-fetch so shared_with/is_shared
          // reflect the server state after the removal.
          await reconcileNoteFromServer(db, affectedNoteIds(endpoint, body)[0]);
        }
      }

      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);

      // The write landed: if this note was carrying a prior failure, clear it so
      // it resumes syncing from the server normally (#492). Guarded UPDATE, so a
      // no-op for the common (already-synced) case.
      for (const noteId of affectedNoteIds(endpoint, body)) {
        await clearNoteSyncFailed(db, noteId);
      }
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;

      // `isTransientHttpStatus(undefined)` is true, so reaching this branch
      // guarantees `status` is a defined, non-transient HTTP code.
      if (status !== undefined && !isTransientHttpStatus(status)) {
        // Permanent client error (e.g. 400/403/404/409/422) — replaying will
        // never succeed, so discard the entry and continue rather than letting one
        // bad operation wedge the whole queue indefinitely.
        // Report the effective (id-remapped) endpoint so it agrees with the
        // dead_letter row recorded below.
        console.warn(`Discarding queued operation id=${entry.id} (HTTP ${status})`);
        discardedOperations.push({ operation: entry.operation, endpoint, status });

        // A 409 from a create/duplicate replay is an idempotent already-applied
        // conflict (the original request already committed): the local state is
        // correct, so resolve it silently. A 409 from an `update` or
        // `convertNoteType` is an optimistic-concurrency conflict — the note
        // changed on another device since the edit's base_version (#489) — so it
        // is real potential data loss and must be dead-lettered like any other
        // permanent failure, so the edit is preserved and surfaced ("changed on
        // another device") via the failed-changes banner instead of being
        // silently dropped. Every other permanent status also dead-letters (#492).
        //
        // createLabel 409s require special handling: the conflict response body
        // doesn't include the canonical label ID, so we resolve it via GET /labels.
        // If the server label ID differs from the client-supplied body.id (name
        // conflict vs. a different label), we remap it so downstream rename/delete
        // ops reference the correct server ID. If the lookup fails or the label
        // isn't found, dead-letter instead of silently dropping a potentially
        // broken id-mapping.
        //
        // A permanently-rejected image delete (404: image or its cascade-deleted
        // parent note already gone; 403: access revoked; etc.) always resolves
        // silently rather than dead-lettering. The dead-letter "Keep my
        // version"/Discard recovery flow (useSyncFailures.ts) is built around
        // preserving *note content* — forking the whole note (sans images) into
        // a duplicate — which is a meaningless, confusing response to a failed
        // *image removal*. The image spec's own client-deferred-delete design
        // already treats "the DELETE never landed" as fail-safe (the image just
        // reappears on the next server sync, per §6); a background fetch or SSE
        // event reconciles the note's images either way, so there is nothing to
        // preserve here that a full note-fork would help with (issue #618's
        // "reconcile queued removals … gracefully").
        // A "gone" replay (404/410) of a destructive/restore op is an idempotent
        // success — the desired end-state already holds — so resolve it silently
        // rather than dead-lettering (see GONE_IDEMPOTENT_OPERATIONS).
        const targetGone = status === 404 || status === 410;
        let idempotentConflict =
          (status === 409
            && entry.operation !== 'update'
            && entry.operation !== 'convertNoteType'
            && entry.operation !== 'createLabel') ||
          entry.operation === 'removeImage' ||
          (targetGone && GONE_IDEMPOTENT_OPERATIONS.has(entry.operation));
        if (status === 409 && entry.operation === 'createLabel') {
          const clientLabelId = body?.id as string | undefined;
          const labelName = body?.name as string | undefined;
          if (clientLabelId && labelName) {
            try {
              const labelsResp = await api.get<Array<{ id: string; name: string }>>('/labels');
              const serverLabel = (labelsResp.data ?? []).find(
                (l) => l.name.toLowerCase() === labelName.toLowerCase(),
              );
              if (serverLabel) {
                if (serverLabel.id !== clientLabelId) {
                  // Name conflict: another label owns this name with a different server
                  // ID. Remap so downstream rename/delete ops use the correct ID.
                  idMap.set(clientLabelId, serverLabel.id);
                }
                idempotentConflict = true;
              }
              // serverLabel not found: fall through to dead-letter
            } catch {
              // GET /labels failed: fall through to dead-letter
            }
          }
        }
        if (!idempotentConflict) {
          const noteIds = affectedNoteIds(endpoint, body);
          // Only link dead_letter.note_id when there's a single clear note (per the
          // schema contract); a multi-note op like reorder stores NULL. The note(s)
          // are still each flagged failed below regardless.
          await recordDeadLetter(db, entry, endpoint, body, status, noteIds.length === 1 ? noteIds[0] : null, {
            attempts: entry.attempts ?? 0,
            errorMessage: axios.isAxiosError(err) ? err.message : null,
          });
          for (const noteId of noteIds) {
            await markNoteSyncFailed(db, noteId);
          }
          // A dead-lettered create never reached the server, so drop its note's
          // later queued ops instead of 404-ing each one (issue #714 cascade).
          if (entry.operation === 'create' || entry.operation === 'duplicate') {
            for (const noteId of noteIds) abandonedCreateNoteIds.add(noteId);
          }
        } else if (entry.operation === 'create' || entry.operation === 'duplicate') {
          // Replaying a create/duplicate whose original already committed: the
          // note exists on the server, so clear its pending-create marker (#475).
          for (const noteId of affectedNoteIds(endpoint, body)) {
            await clearNotePendingCreate(db, noteId);
          }
        }

        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      } else if (isGlobalDrainFailure(err, status)) {
        // No usable server response (network error/timeout) or a status that
        // blocks the whole queue regardless of this entry (401 re-auth, 408,
        // 429 rate-limit). Every entry would fail the same way, so stop the
        // drain without charging this entry's attempt counter and retry the
        // remainder on the next reconnect (issue #714).
        console.warn(`Queue drain stopped at entry id=${entry.id} (connectivity):`, err);
        break;
      } else {
        // Entry-specific transient failure: a 5xx tied to this op's payload, or a
        // non-HTTP error thrown while processing this entry (corrupted body, a
        // local DB error). Charge the entry's attempt counter; once it has failed
        // MAX_ENTRY_DRAIN_ATTEMPTS times, dead-letter it and continue *past* it so
        // it can't wedge the FIFO head forever (issue #714). Below the cap, stop
        // and retry the whole queue on the next drain (preserving FIFO/backoff).
        const attempts = (entry.attempts ?? 0) + 1;
        await db.runAsync('UPDATE sync_queue SET attempts = ? WHERE id = ?', [attempts, entry.id]);

        if (attempts < MAX_ENTRY_DRAIN_ATTEMPTS) {
          console.warn(
            `Queue drain stopped at entry id=${entry.id} (attempt ${attempts}/${MAX_ENTRY_DRAIN_ATTEMPTS}):`,
            err,
          );
          break;
        }

        // Cap reached — dead-letter and continue. Use the effective (id-remapped)
        // endpoint/body so the row agrees with what was actually sent. HTTP 5xx
        // keeps its status; a non-HTTP throw records PROCESSING_ERROR_STATUS (0).
        const deadLetterStatus = status ?? PROCESSING_ERROR_STATUS;
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.warn(
          `Dead-lettering queued operation id=${entry.id} after ${attempts} failed attempts ` +
            `(${deadLetterStatus === PROCESSING_ERROR_STATUS ? 'processing error' : `HTTP ${deadLetterStatus}`}): ${errorMessage}`,
        );
        const noteIds = affectedNoteIds(endpoint, body);
        discardedOperations.push({ operation: entry.operation, endpoint, status: deadLetterStatus });
        await recordDeadLetter(db, entry, endpoint, body, deadLetterStatus, noteIds.length === 1 ? noteIds[0] : null, {
          attempts,
          errorMessage,
        });
        for (const noteId of noteIds) {
          await markNoteSyncFailed(db, noteId);
        }
        if (entry.operation === 'create' || entry.operation === 'duplicate') {
          for (const noteId of noteIds) abandonedCreateNoteIds.add(noteId);
        }
        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      }
    }
  }

  return { idMappings, discardedOperations, syncedSettings };
}

/**
 * Persist a note returned by the server during queue drain, if the response looks
 * like a note. Deliberately uses the raw (ungated) saveNote, not saveServerNote:
 * this runs as the queue entry for that note is being drained, so the entry is
 * still pending and the gate would refuse the server's authoritative response for
 * the very note we just synced. The drain owns the note here (#487).
 */
async function saveNoteFromResponse(db: SQLiteDatabase, data: unknown): Promise<void> {
  if (hasStringId(data)) {
    await saveNote(db, data as Note);
  }
}

/**
 * Re-fetch a note from the server and reconcile its share state during queue
 * drain. Used by share/unshare ops, which return 204 (no body) yet leave the
 * local note holding an optimistic `shared_with` (a synthetic `optimistic_<userId>`
 * row, or a row the unshare removed): a GET reconciles it to the server-assigned
 * share ids. Only the share columns are written (not a full saveNote) so a content
 * edit still queued for the same note isn't clobbered — the `update` drain bumps
 * only the version, so a full overwrite would revert that pending edit until the
 * next background sync. Best-effort: a failed fetch leaves the optimistic state
 * for the next background sync to reconcile.
 */
async function reconcileNoteFromServer(db: SQLiteDatabase, noteId: string | undefined): Promise<void> {
  if (!noteId) return;
  try {
    const data = (await api.get(`/notes/${noteId}`))?.data;
    if (hasStringId(data)) {
      const note = data as Note;
      await updateLocalNoteShares(db, note.id, {
        is_shared: note.is_shared,
        shared_with: note.shared_with ?? [],
      });
    }
  } catch (err) {
    console.warn(`Failed to reconcile note id=${noteId} after share/unshare drain:`, err);
  }
}
