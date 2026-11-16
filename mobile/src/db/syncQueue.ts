import type { SQLiteDatabase } from 'expo-sqlite';
import axios from 'axios';
import api from '../api/client';
import { jot } from '../api/jot';
import { completedCascadeScope, type GetNotesParams, type Note, type NoteItem } from '@jot/shared';
import {
  getLocalNote,
  markLocalNoteDeleted,
  permanentDeleteLocalNote,
  saveNote,
  saveServerSnapshotNotes,
  saveLabels,
  reconcileLocalItems,
  reconcileServerNotesScope,
  type ServerItemInput,
  markNoteSyncFailed,
  clearNoteSyncFailed,
  clearNotePendingCreate,
  getFailedNoteIds,
  getLocalNoteVersion,
  setLocalNoteVersion,
  updateLocalNoteShares,
} from './noteQueries';
import { isLocalModeActive } from '../store/localMode';
import {
  insertKeys,
  keyIdExpression,
  keyKindCondition,
  noteIdsOf,
  noteKey,
  type QueueKey,
} from './queueKeys';
import { withSerializedTransaction } from './transaction';
import { rewriteLabelId } from './labelIdRewrite';
import { notesWrittenSince, recordWriteLanded, snapshotMark, type SnapshotMark } from './snapshotGate';
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
  | 'setItemsCompleted'
  | 'deleteCompletedItems'
  | 'share'
  | 'unshare'
  | 'createLabel'
  | 'renameLabel'
  | 'deleteLabel'
  | 'addLabelToNote'
  | 'removeLabelFromNote'
  | 'updateSettings'
  | 'removeImage'
  | 'markViewed';

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
  /**
   * What the op touches (see queueKeys.ts): every note it writes or reads, and
   * every label it names. Recorded in `sync_queue_keys`, which is what the
   * protected set and the per-note queue lookups read (#1282).
   */
  keys: readonly QueueKey[];
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
 *
 * Two failures are ambiguous: a gateway status (502/503/504) and a client-side
 * timeout. Usually the server is down or unreachable (global), but a request
 * that reproducibly exceeds the proxy's or the client's timeout fails that way
 * every time while every other request succeeds (#1211). The drains resolve
 * that with {@link isGlobalDrainFailureProbed} — always call that one; this
 * synchronous check treats a gateway status as entry-specific and a client
 * timeout as global.
 */
function isGlobalDrainFailure(err: unknown): boolean {
  // A non-HTTP error thrown while processing an entry is specific to that entry.
  if (!axios.isAxiosError(err)) return false;
  // Transport-level failure with no server response: network down or timeout.
  if (err.response === undefined) return true;
  // Statuses that block the whole queue regardless of the specific entry.
  const { status } = err.response;
  return status === 401 || status === 408 || status === 429;
}

/**
 * Whether an HTTP status is a gateway error (502 Bad Gateway, 503 Service
 * Unavailable, 504 Gateway Timeout). Jot's API never returns these — its only
 * 503 is the `/readyz` probe — so they come from a reverse proxy in front of it.
 */
function isGatewayStatus(status: number | undefined): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Whether a request failed because the client gave up waiting for a response
 * (axios reports its own `timeout` as ECONNABORTED, or ETIMEDOUT with
 * `transitional.clarifyTimeoutError`), as opposed to a plain network error.
 * Axios also raises ECONNABORTED as "Request aborted" when the platform aborts
 * the request (no response, no timeout); that is not a timeout, so it stays a
 * plain network error.
 */
function isClientTimeout(err: unknown): boolean {
  if (!axios.isAxiosError(err) || err.response !== undefined) return false;
  if (err.code === 'ETIMEDOUT') return true;
  return err.code === 'ECONNABORTED' && err.message !== 'Request aborted';
}

/**
 * Timeout for a write replayed from the queue. An online write uses the short
 * WRITE_REQUEST_TIMEOUT_MS (api/client.ts) so it falls back to the queue
 * quickly; a replay has no such fallback — it simply stays queued — and a
 * replay that times out while the server answers the probe is charged toward
 * dead-lettering (#1211). So a replay gets a longer budget, letting a large
 * write on a slow but working link complete rather than be dead-lettered.
 * Passed explicitly, so the client's write-timeout interceptor leaves it alone.
 */
export const QUEUED_WRITE_TIMEOUT_MS = 30000;

/** Request config for every replayed queue write. */
const REPLAY_REQUEST_CONFIG = { timeout: QUEUED_WRITE_TIMEOUT_MS } as const;

/** Timeout for the probe in {@link isGlobalDrainFailureProbed}. */
const SERVER_PROBE_TIMEOUT_MS = 5000;

/**
 * {@link isGlobalDrainFailure}, plus a decision on the ambiguous failures: when
 * the entry got a 502/503/504 or timed out client-side, probe the server with a
 * cheap read. If the server answers, the failure was specific to this entry and
 * is charged as usual, so a request that always times out — at the proxy or at
 * the client's own write timeout (#1211) — is still dead-lettered after
 * MAX_ENTRY_DRAIN_ATTEMPTS instead of wedging the queue. If it doesn't, the
 * server is down or unreachable: the failure is global and charges nothing, so
 * an outage no longer turns every queued change into a "couldn't be saved" one.
 * A plain network error (no response, not a timeout) is global without a probe.
 *
 * The drains stop at the first global or below-cap failure, so this probes at
 * most once per drain pass.
 */
export async function isGlobalDrainFailureProbed(err: unknown): Promise<boolean> {
  const ambiguous = isClientTimeout(err)
    || (axios.isAxiosError(err) && isGatewayStatus(err.response?.status));
  if (ambiguous) return !(await serverAnswers());
  return isGlobalDrainFailure(err);
}

/**
 * Whether the server itself answers a request right now. Any response other
 * than a gateway status counts, an error status included.
 */
async function serverAnswers(): Promise<boolean> {
  try {
    await jot.about.get({ timeout: SERVER_PROBE_TIMEOUT_MS });
    return true;
  } catch (probeErr) {
    return axios.isAxiosError(probeErr)
      && probeErr.response !== undefined
      && !isGatewayStatus(probeErr.response.status);
  }
}

/** An error's message without its stack, for log lines where the stack is noise. */
export function errorSummary(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ops a permanent rejection resolves silently, whatever the status, because
 * nothing is lost: the next server sync reconciles what they would have done.
 * `removeImage`: the image just reappears (the image spec's fail-safe design,
 * §6). `markViewed`: the unread badge just stays.
 */
const BEST_EFFORT_OPERATIONS: ReadonlySet<QueueOperation> = new Set([
  'removeImage',
  'markViewed',
]);

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
  'deleteCompletedItems',
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
 * no-op. Do NOT call this from any other code path. The row and its keys are
 * two statements: run it inside a transaction.
 */
export async function insertQueueEntry(db: SQLiteDatabase, params: EnqueueParams): Promise<void> {
  const result = await db.runAsync(
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
  await insertKeys(db, 'sync_queue_keys', result.lastInsertRowId, params.keys);
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
  await withSerializedTransaction(db, () => insertQueueEntry(db, params));
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

export const EMPTY_SYNC_QUEUE_STATS: SyncQueueStats = { pendingCount: 0, head: null, maxAttempts: 0 };

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
 * The notes a queued op writes, from its keys. A duplicate also keys its source
 * note, which it only reads (so the source's queued writes land first); it
 * writes the clone alone, its client-supplied `id`. This is what a landing is
 * recorded for, what a dead letter links and flags failed, and what the drain
 * pulls afterwards.
 */
function writtenNoteIds(
  operation: QueueOperation,
  keys: readonly string[],
  body: Record<string, unknown> | undefined,
): string[] {
  if (operation === 'duplicate') {
    const cloneId = body?.id;
    return typeof cloneId === 'string' ? [cloneId] : [];
  }
  return noteIdsOf(keys);
}

/** Every queued entry's keys, by entry id. */
async function getQueueKeysByEntry(db: SQLiteDatabase): Promise<Map<number, string[]>> {
  const rows = await db.getAllAsync<{ entry_id: number; key: string }>('SELECT entry_id, key FROM sync_queue_keys');
  const byEntry = new Map<number, string[]>();
  for (const row of rows) {
    const keys = byEntry.get(row.entry_id);
    if (keys) keys.push(row.key);
    else byEntry.set(row.entry_id, [row.key]);
  }
  return byEntry;
}

/**
 * The notes a dead-lettered op touched, from its recorded keys. A multi-note op
 * like `reorder` records its dead_letter row with `note_id = NULL` yet still
 * flags every affected note `sync_state = 'failed'`, so the sync-failure
 * resolution flow uses this to clear all of those per-note badges — not just
 * the single linked note (#493).
 */
export async function getDeadLetterNoteIds(db: SQLiteDatabase, deadLetterId: number): Promise<string[]> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT ${keyIdExpression('key', 'note')} AS id FROM dead_letter_keys
     WHERE dead_letter_id = ? AND ${keyKindCondition('key', 'note')}`,
    [deadLetterId],
  );
  return rows.map((row) => row.id);
}

/**
 * Collect the IDs of every note that currently has a pending operation in the
 * sync queue. Server-sourced read paths (background fetch, SSE) consult this set
 * so a fetch of stale server state can't transiently revert an optimistic local
 * edit before its queued op has drained (see issue #487).
 */
export async function getPendingNoteIds(db: SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT DISTINCT ${keyIdExpression('key', 'note')} AS id FROM sync_queue_keys
     WHERE ${keyKindCondition('key', 'note')}`,
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Notes a dead letter still covers: the note it is linked to, or every note a
 * multi-note op (`note_id = NULL`, e.g. reorder) touched. `exceptDeadLetterId`
 * leaves out the row being resolved. The dead letters are what the user has
 * yet to review, so they — not the `failed` flag alone — decide whether a
 * note's preserved local content is still needed (#1263).
 */
async function getDeadLetteredNoteIds(db: SQLiteDatabase, exceptDeadLetterId?: number): Promise<Set<string>> {
  const except = exceptDeadLetterId ?? null;
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT note_id AS id FROM dead_letter WHERE note_id IS NOT NULL AND id IS NOT ?
     UNION
     SELECT ${keyIdExpression('k.key', 'note')} FROM dead_letter_keys k
       JOIN dead_letter d ON d.id = k.dead_letter_id
     WHERE d.note_id IS NULL AND d.id IS NOT ? AND ${keyKindCondition('k.key', 'note')}`,
    [except, except],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Clear the note's `sync_state = 'failed'` flag unless a dead letter other than
 * `exceptDeadLetterId` still covers it. A later write that lands for the note
 * does not resolve an earlier failure: "Keep my version" forks the local row,
 * so the row must stay protected until the user has reviewed every failure on
 * it (#1263).
 */
export async function clearNoteSyncFailedIfResolved(
  db: SQLiteDatabase,
  noteId: string,
  exceptDeadLetterId?: number,
): Promise<void> {
  if ((await getDeadLetteredNoteIds(db, exceptDeadLetterId)).has(noteId)) return;
  await clearNoteSyncFailed(db, noteId);
}

/**
 * Notes that server-sourced writes must leave untouched: those with a pending
 * queue op (#487), those with a queued or errored image upload (#1279), plus
 * those with an unresolved failure (#492): flagged `sync_state = 'failed'`, or
 * still covered by a dead letter (#1263). A dead-lettered note no longer has a
 * queue row, so this is what keeps its preserved local content from being
 * overwritten or pruned by a later background fetch / SSE event.
 */
export async function getProtectedNoteIds(db: SQLiteDatabase): Promise<Set<string>> {
  const [pending, failed, deadLettered, uploads] = await Promise.all([
    getPendingNoteIds(db),
    getFailedNoteIds(db),
    getDeadLetteredNoteIds(db),
    getNoteIdsWithPendingUploads(db),
  ]);
  for (const id of failed) pending.add(id);
  for (const id of deadLettered) pending.add(id);
  for (const id of uploads) pending.add(id);
  return pending;
}

/**
 * Notes with a `queued` or `error` row in `pending_image_uploads`. A queued photo
 * is an unsynced local change that has no `sync_queue` row, and the upload row
 * cascade-deletes with its note, so pruning the note would drop the photo
 * unuploaded (#1279).
 */
async function getNoteIdsWithPendingUploads(db: SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ note_id: string }>(
    `SELECT DISTINCT note_id FROM pending_image_uploads WHERE status IN ('queued', 'error')`,
  );
  return new Set(rows.map((r) => r.note_id));
}

/**
 * Notes a server snapshot taken at `since` must leave untouched: the
 * {@link getProtectedNoteIds} set plus every note one of this device's writes
 * landed on after `since`. The snapshot may predate that write, and its queue
 * row (if it had one) is already gone, so only the landing record still knows
 * (#1265; see snapshotGate.ts).
 */
export async function getSnapshotSkipNoteIds(db: SQLiteDatabase, since: SnapshotMark): Promise<Set<string>> {
  return (await readSnapshotSkips(db, since)).skipNoteIds;
}

/**
 * Apply the server's report that `noteId` is gone (a 404/410 on fetch, an SSE
 * delete or unshare) unless the note is in the {@link getSnapshotSkipNoteIds}
 * set for `since`: a queued or failed change, or a write of this device's
 * (say a restore) that landed after the report was taken. `tombstone` marks
 * it deleted; `delete` removes the row. The check and the write run in one
 * serialized transaction, so a write cannot slip in between (#1265, spec
 * §8.3). `shouldApply` is consulted in the same step, for a caller whose
 * reason to write may lapse while it waits. Returns whether the note was
 * removed.
 */
export async function applyServerRemoval(
  db: SQLiteDatabase,
  noteId: string,
  since: SnapshotMark,
  kind: 'tombstone' | 'delete',
  shouldApply: () => boolean = () => true,
): Promise<boolean> {
  let removed = false;
  await withSerializedTransaction(db, async () => {
    const { skipNoteIds } = await readSnapshotSkips(db, since);
    if (skipNoteIds.has(noteId) || !shouldApply()) return;
    if (kind === 'tombstone') await markLocalNoteDeleted(db, noteId);
    else await permanentDeleteLocalNote(db, noteId);
    removed = true;
  });
  return removed;
}

/** {@link getSnapshotSkipNoteIds}, keeping the notes written since `since` apart. */
async function readSnapshotSkips(
  db: SQLiteDatabase,
  since: SnapshotMark,
): Promise<{ skipNoteIds: Set<string>; writtenNoteIds: Set<string> }> {
  const skipNoteIds = await getProtectedNoteIds(db);
  const writtenNoteIds = notesWrittenSince(since);
  for (const id of writtenNoteIds) skipNoteIds.add(id);
  return { skipNoteIds, writtenNoteIds };
}

/**
 * Persist a note fetched from the server (background fetch, SSE, post-import sync),
 * leaving notes with a pending or failed local op untouched (see
 * {@link getProtectedNoteIds} for the rationale, #487/#492), and notes this
 * device wrote after `since`, the {@link snapshotMark} taken before the fetch
 * (#1265). Once the queue drains and any failure is resolved the gate is empty,
 * so the next server fetch or SSE event re-applies canonical server state
 * normally.
 */
export async function saveServerNote(db: SQLiteDatabase, note: Note, since: SnapshotMark): Promise<void> {
  await saveServerNotes(db, [note], since);
}

/**
 * Items of `noteId` whose completed flag a queued, not-yet-replayed
 * `setItemsCompleted` op will still set: the item-level
 * counterpart of {@link getProtectedNoteIds} for writers that must apply the
 * rest of a server snapshot. Until the op replays, the server's copy of these
 * items predates it, so a snapshot's completed value for them is stale — keep
 * the local one. Read from the queue itself, so it holds across restarts.
 * `exceptEntryId` leaves out the entry whose own response is being applied.
 */
export async function getQueuedCompletedItemIds(
  db: SQLiteDatabase,
  noteId: string,
  exceptEntryId?: number,
): Promise<Set<string>> {
  const entries = await db.getAllAsync<Pick<QueueEntry, 'body'>>(
    `SELECT q.body FROM sync_queue q JOIN sync_queue_keys k ON k.entry_id = q.id
     WHERE q.operation = 'setItemsCompleted' AND k.key = ? AND q.id IS NOT ?`,
    [noteKey(noteId), exceptEntryId ?? null],
  );
  const ids = new Set<string>();
  let localItems: NoteItem[] | null = null;
  for (const entry of entries) {
    const body = parseQueueBody(entry.body);
    const itemIds = body?.item_ids;
    if (!Array.isArray(itemIds)) continue;
    // The op names only the tapped items; each one's cascade is recovered from
    // the local note, whose rows the op already wrote.
    if (localItems === null) {
      const note = await getLocalNote(db, noteId);
      localItems = note?.note_type === 'list' ? note.items ?? [] : [];
    }
    const scopeItems = localItems.map((i) => ({ id: i.id, parentId: i.parent_id }));
    for (const itemId of itemIds) {
      if (typeof itemId !== 'string') continue;
      ids.add(itemId);
      for (const id of completedCascadeScope(scopeItems, itemId, body?.completed === true)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Batch counterpart of {@link saveServerNote}. The skip set is read once,
 * inside the write's transaction.
 */
export async function saveServerNotes(db: SQLiteDatabase, notes: Note[], since: SnapshotMark): Promise<void> {
  await saveServerSnapshotNotes(db, notes, () => readSnapshotSkips(db, since));
}

/**
 * Labels with an unsynced offline `createLabel` op still queued: their client id
 * *is* the server id (#546), but the create hasn't reached the server yet, so a
 * canonical GET /labels won't list them. They must be protected from pruning
 * when reconciling the label store (see {@link saveServerLabels}).
 */
export async function getPendingLabelIds(db: SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT DISTINCT ${keyIdExpression('k.key', 'label')} AS id FROM sync_queue_keys k
       JOIN sync_queue q ON q.id = k.entry_id
     WHERE q.operation = 'createLabel' AND ${keyKindCondition('k.key', 'label')}`,
  );
  return new Set(rows.map((row) => row.id));
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
 * Reconcile a scoped server note list, fetched after `since` was taken, into
 * local SQLite. Delegates to {@link reconcileServerNotesScope}, which reads the
 * skip set (see {@link getSnapshotSkipNoteIds}) and applies the save and the
 * prune in one transaction.
 */
export async function saveServerNotesScope(
  db: SQLiteDatabase,
  serverNotes: Note[],
  params: GetNotesParams | undefined,
  since: SnapshotMark,
): Promise<void> {
  await reconcileServerNotesScope(db, serverNotes, params, () => readSnapshotSkips(db, since));
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
   * failure with no HTTP status: a non-HTTP local processing error (issue #714)
   * or a client timeout while the server answered the probe (#1211).
   */
  status: number;
}

export interface DrainResult {
  /**
   * The canonical server note returned for each drained create/duplicate
   * operation whose response was applied locally — that is, no later op for the
   * note was still queued (see {@link saveServerResponseNote}).
   */
  syncedNotes: Note[];
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
  /**
   * Transient drain attempts made before giving up (0 for a permanent first-try
   * discard); #714. Optional so callers constructing a DeadLetteredOperation by
   * hand don't have to supply it — reads normalize it to a concrete value.
   */
  attempts?: number;
  /** Last error text, when the discard came from a repeated transient/processing failure (#714). Optional; see `attempts`. */
  error_message?: string | null;
}

/**
 * Read all preserved dead-lettered ops, oldest first. Normalizes the #714
 * columns (`attempts`, `error_message`) at the database boundary so every
 * consumer sees concrete values even for rows written before those columns
 * existed (defaulted by migration 6) or by older code paths.
 */
export async function getDeadLetteredOperations(db: SQLiteDatabase): Promise<DeadLetteredOperation[]> {
  const rows = await db.getAllAsync<DeadLetteredOperation>('SELECT * FROM dead_letter ORDER BY id ASC');
  return rows.map((row) => ({ ...row, attempts: row.attempts ?? 0, error_message: row.error_message ?? null }));
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
 * (issue #492). `endpoint`/`body` are the values that were actually sent; `noteId` links the row to the affected note when there is
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
  const result = await db.runAsync(
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
  // The dead letter keeps the entry's keys, so it names its notes without a parse.
  await db.runAsync(
    'INSERT OR IGNORE INTO dead_letter_keys (dead_letter_id, key) SELECT ?, key FROM sync_queue_keys WHERE entry_id = ?',
    [result.lastInsertRowId, entry.id],
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
 *   - *Global* connectivity failures — no server response (a network error, or a
 *     client timeout / gateway status while the server does not answer a probe)
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
 * adopted locally — once no later op for the note is queued, see
 * saveServerResponseNote — and the pending-create marker is cleared.
 *
 * Returns the canonical notes of the creates that succeeded, so callers can
 * update their caches.
 */
export async function drainQueue(db: SQLiteDatabase): Promise<DrainResult> {
  const entries = await db.getAllAsync<QueueEntry>(
    'SELECT * FROM sync_queue ORDER BY id ASC',
  );
  let keysByEntry = await getQueueKeysByEntry(db);

  const syncedNotes: Note[] = [];
  const discardedOperations: DiscardedOperation[] = [];
  // Notes whose offline `create`/`duplicate` was dead-lettered this drain: the
  // note never reached the server, so every later queued op for it would 404 and
  // dead-letter one-by-one (a pile of rows for a single note). Instead we drop
  // those dependents in place — the note is already flagged `failed`, and the
  // "Keep my version" fork rebuilds from the note's *local* content, which still
  // carries the whole chained edit (issue #714 cascade).
  const abandonedCreateNoteIds = new Set<string>();
  // Notes a landed replay touched whose local row no response has settled
  // since: an op that returns no note, or a response held back because other
  // ops were queued or a failed change is unresolved. Pulled from the server
  // once the drain ends (#1262, spec §8.3).
  const pullNoteIds = new Set<string>();
  // Notes the current entry's response was saved to in full.
  let settledThisEntry = new Set<string>();
  // Set when the drain stops on a connectivity failure: the post-drain pull
  // would only time out against the same unreachable server.
  let stoppedOnConnectivity = false;
  let syncedSettings = false;

  // Applies a replayed write's note response (see saveServerResponseNote).
  // Returns the note when it was saved in full.
  const applyResponse = async (
    entryId: number,
    data: unknown,
    ownVersion: boolean,
  ): Promise<Note | null> => {
    if (!hasStringId(data)) return null;
    const note = data as Note;
    if (!(await saveServerResponseNote(db, note, { exceptEntryId: entryId, ownVersion }))) return null;
    settledThisEntry.add(note.id);
    return note;
  };

  for (const entry of entries) {
    settledThisEntry = new Set<string>();
    // Declared outside the try so the catch can dead-letter using the endpoint
    // and body that were actually sent to the server.
    let endpoint = entry.endpoint;
    let body: Record<string, unknown> | undefined;
    // Flipped true the instant the server request returns 2xx. After that point a
    // throw is a *local reconciliation* failure, not a failed write, so it must
    // not retry or dead-letter the entry (issue #714 — mirrors imageUploadQueue's
    // "the upload already landed, so remove the queue entry first").
    let requestLanded = false;
    // The notes this entry writes; reads `body` once it is parsed.
    const targets = (): string[] => writtenNoteIds(entry.operation, keysByEntry.get(entry.id) ?? [], body);
    try {
      if (entry.body) {
        body = JSON.parse(entry.body) as Record<string, unknown>;
      }

      // If this op targets a note whose create was just dead-lettered, replaying
      // it against a note the server never got is pointless — drop it (the note
      // stays flagged failed) rather than round-tripping to a guaranteed 404.
      if (abandonedCreateNoteIds.size > 0) {
        const touched = targets();
        if (touched.length > 0 && touched.every((id) => abandonedCreateNoteIds.has(id))) {
          console.warn(
            `Dropping queued operation id=${entry.id} (${entry.operation}): its note's create was dead-lettered.`,
          );
          await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
          continue;
        }
      }

      // The base_version this replay was sent with, if it was version-guarded.
      let baseVersion: number | null = null;
      if (entry.method === 'POST') {
        if (entry.operation === 'convertNoteType' && body) {
          // Resolve base_version from the note's current local version at replay
          // time, matching `update` (#489): a chain of offline edits to one note
          // (e.g. a scalar update followed by a convert) then replays each op
          // against the version the previous one left behind instead of the
          // stale value captured when this op was first queued.
          const noteId = targets()[0];
          baseVersion = noteId ? await getLocalNoteVersion(db, noteId) : null;
          if (baseVersion !== null) body.base_version = baseVersion;
        }
        const response = await api.post(endpoint, body, REPLAY_REQUEST_CONFIG);
        requestLanded = true;

        if (entry.operation === 'create' || entry.operation === 'duplicate') {
          // The server keeps the client-supplied `id`, so the id is stable —
          // adopt the canonical note (server item ids etc.) and clear the
          // pending-create marker. Nobody else can have
          // edited a note the server only just created, so its version is ours.
          const clientId = body?.id as string | undefined;
          const data = response?.data;
          if (clientId && hasStringId(data)) {
            const serverNote = await applyResponse(entry.id, data, true);
            if (serverNote) syncedNotes.push(serverNote);
            await clearNotePendingCreate(db, clientId);
          }
        } else if (entry.operation === 'addLabelToNote') {
          // The server returns the updated note; persist it so labels_json
          // reflects the server-assigned label id (replacing any local id).
          // Labels are not version-guarded, so its version may carry a
          // collaborator's edit.
          await applyResponse(entry.id, response?.data, false);
        } else if (
          entry.operation === 'setItemsCompleted' ||
          entry.operation === 'deleteCompletedItems'
        ) {
          // endpoints: .../items/set-completed and
          // .../items/delete. Both return the note's full, authoritative
          // item list (the delete endpoint's is the post-delete remainder), so
          // reconcile every field and prune any local row absent from it —
          // not just patch `completed` on the rows present — otherwise a
          // stale local row (e.g. leftover parent_id/position from an earlier
          // partial sync, or one deleted by another session while this
          // device was offline) never gets corrected.
          await reconcileItemsFromResponse(db, endpoint.split('/')[2]!, response?.data, entry.id);
        } else if (entry.operation === 'share') {
          // Share returns 204 (no body) and the optimistic local note carries a
          // synthetic `optimistic_<userId>` share row; re-fetch the canonical note
          // so shared_with reflects the server-assigned share ids.
          await reconcileNoteFromServer(db, targets()[0]);
        } else if (entry.operation === 'convertNoteType') {
          // The server returns the full converted note (authoritative version,
          // updated_at, and item ids); persist it rather than trusting the local
          // optimistic apply to still be in sync after other edits may have
          // queued in between.
          await applyResponse(entry.id, response?.data, isOwnVersion(response?.data, baseVersion));
        }
      } else if (entry.method === 'PATCH') {
        const updateNoteID =
          entry.operation === 'update' ? targets()[0] : undefined;
        if (updateNoteID !== undefined && body && ('content' in body || 'title' in body)) {
          // Resolve the optimistic-concurrency base from the note's current local
          // version at replay time. applyResponse below advances that version
          // after each drained edit, so a chain of offline edits to one note
          // replays against the right base even across separate drains; a note
          // changed on another device keeps its stale local version (it's
          // protected from server overwrite while queued, #487), so a real
          // conflict is still caught (#489).
          baseVersion = await getLocalNoteVersion(db, updateNoteID);
          if (baseVersion !== null) body.base_version = baseVersion;
        }
        const response = await api.patch(endpoint, body, REPLAY_REQUEST_CONFIG);
        requestLanded = true;
        if (entry.operation === 'updateSettings') {
          syncedSettings = true;
        } else if (updateNoteID !== undefined) {
          // A per-user change (pinned, color, …) is not version-guarded, so its
          // response version may include a collaborator's edit this device has
          // not seen; adopting it would let the next content edit pass the
          // base_version check and overwrite that edit (#1262).
          await applyResponse(entry.id, response?.data, isOwnVersion(response?.data, baseVersion));
        }
      } else if (entry.method === 'DELETE') {
        const response = await api.delete(endpoint, REPLAY_REQUEST_CONFIG);
        requestLanded = true;
        if (entry.operation === 'removeLabelFromNote') {
          // The server returns the updated note; persist it so the local
          // labels_json drops the removed label and stays consistent.
          await applyResponse(entry.id, response?.data, false);
        } else if (entry.operation === 'unshare') {
          // Unshare returns 204 (no body); re-fetch so shared_with/is_shared
          // reflect the server state after the removal.
          await reconcileNoteFromServer(db, targets()[0]);
        }
      }

      // The API client already recorded this landing from the request, except
      // for a removeImage replay: it sends no body, so its note id is only
      // here (#1265). Recording a landing twice would skip a snapshot fetched
      // between the two.
      if (entry.operation === 'removeImage') recordWriteLanded(targets());
      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);

      // The write landed: if this note was carrying a prior failure that no
      // dead letter still records, clear it so it resumes syncing from the
      // server normally (#492). An unresolved dead letter keeps it (#1263).
      for (const noteId of targets()) {
        await clearNoteSyncFailedIfResolved(db, noteId);
        // A trashed or deleted note has nothing left to pull; one this
        // response settled is already current.
        const gone = entry.operation === 'delete' || entry.operation === 'permanentDelete';
        if (gone || settledThisEntry.has(noteId)) pullNoteIds.delete(noteId);
        else pullNoteIds.add(noteId);
      }
    } catch (err) {
      if (requestLanded) {
        // The server write already succeeded; only a later local reconciliation
        // step (saveNote, patchLocalItem, version bump, the entry delete itself)
        // threw. Retrying or dead-lettering would re-send a write the server has
        // already applied, so drop the entry and move on — the local cache is
        // reconciled by the next server fetch / SSE event. Attempt counting is
        // reserved for failures *before* the request lands (issue #714).
        console.warn(`Queue entry id=${entry.id} landed server-side; post-response reconciliation failed:`, err);
        if (entry.operation === 'removeImage') recordWriteLanded(targets());
        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
        continue;
      }

      const status = axios.isAxiosError(err) ? err.response?.status : undefined;

      // `isTransientHttpStatus(undefined)` is true, so reaching this branch
      // guarantees `status` is a defined, non-transient HTTP code.
      if (status !== undefined && !isTransientHttpStatus(status)) {
        // Permanent client error (e.g. 400/403/404/409/422) — replaying will
        // never succeed, so discard the entry and continue rather than letting one
        // bad operation wedge the whole queue indefinitely.
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
        // conflict vs. a different label), the id is rewritten in the queue, the
        // label store and the local notes (see rewriteLabelId), so ops behind it
        // — in this drain or a later one — reference the surviving label. If the
        // lookup fails or the label isn't found, dead-letter instead of silently
        // dropping a potentially broken id mapping.
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
          BEST_EFFORT_OPERATIONS.has(entry.operation) ||
          (targetGone && GONE_IDEMPOTENT_OPERATIONS.has(entry.operation));
        if (status === 409 && entry.operation === 'createLabel') {
          const clientLabelId = body?.id as string | undefined;
          const labelName = body?.name as string | undefined;
          if (clientLabelId && labelName) {
            // GET /labels failing, or no label by that name, falls through to dead-letter.
            const serverLabel = await jot.labels
              .getAll()
              .then((labels) => labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase()))
              .catch(() => undefined);
            if (serverLabel) {
              if (serverLabel.id !== clientLabelId) {
                // Name conflict: another label owns this name under a different
                // id, so the client id never reaches the server. Persist the
                // resolution so every later op (and local copy) uses that label.
                // A failure here is a local processing error and propagates as
                // one rather than dead-lettering a create the server did resolve.
                await withSerializedTransaction(db, () =>
                  rewriteLabelId(db, clientLabelId, serverLabel.id, serverLabel),
                );
                // The drain snapshot predates the rewrite: refresh the rows behind this one.
                const rewritten = new Map(
                  (await db.getAllAsync<QueueEntry>('SELECT * FROM sync_queue WHERE id > ?', [entry.id]))
                    .map((row) => [row.id, row]),
                );
                for (const later of entries) {
                  const fresh = rewritten.get(later.id);
                  if (fresh) {
                    later.endpoint = fresh.endpoint;
                    later.body = fresh.body;
                  }
                }
                keysByEntry = await getQueueKeysByEntry(db);
              }
              idempotentConflict = true;
            }
          }
        }
        if (!idempotentConflict) {
          // The edit is lost server-side (the failed-changes banner surfaces it),
          // so this one is worth a warning.
          console.warn(`Discarding queued operation id=${entry.id} ${entry.operation} ${endpoint} (HTTP ${status})`);
          const noteIds = targets();
          // Only link dead_letter.note_id when there's a single clear note (per the
          // schema contract); a multi-note op like reorder stores NULL. The note(s)
          // are still each flagged failed below regardless.
          await recordDeadLetter(db, entry, endpoint, body, status, noteIds.length === 1 ? noteIds[0]! : null, {
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
          for (const noteId of targets()) {
            await clearNotePendingCreate(db, noteId);
          }
        }

        if (idempotentConflict) {
          // Nothing is lost: the server already holds the desired end state, or
          // (removeImage) the next sync reconciles it.
          console.info(
            `Dropping queued operation id=${entry.id} ${entry.operation} ${endpoint} (HTTP ${status}): no replay needed`,
          );
          // The end state is already on the server (an earlier attempt landed
          // unseen, or the target is gone), and the row that gated snapshots is
          // about to go: a snapshot in flight may predate it (#1265). The API
          // client records only 2xx responses, so this one is ours to record.
          // A viewed ping changes no content (see recordWriteResponse).
          if (entry.operation !== 'markViewed') recordWriteLanded(targets());
        }

        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      } else if (await isGlobalDrainFailureProbed(err)) {
        // No usable server response (a network error, or a timeout while the
        // server does not answer the probe) or a status that blocks the whole
        // queue regardless of this entry (401 re-auth, 408, 429 rate-limit, or
        // a 502/503/504 from a proxy whose server is down).
        // Every entry would fail the same way, so stop the drain without
        // charging this entry's attempt counter and retry the remainder on the
        // next reconnect (issue #714). Expected whenever the
        // server drops away, so info, and the message alone: the stack of a
        // network error is bundle offsets that say nothing.
        console.info(`Queue drain stopped at entry id=${entry.id} (connectivity): ${errorSummary(err)}`);
        stoppedOnConnectivity = true;
        break;
      } else {
        // Entry-specific transient failure: a 5xx tied to this op's payload (a
        // gateway status or a client timeout only when the server answered the
        // probe), or a non-HTTP error thrown while processing this entry
        // (corrupted body, a local DB error). Charge the entry's attempt counter; once it has failed
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

        if (entry.operation === 'markViewed') {
          // Best-effort (see the permanent-failure branch above): a view that
          // keeps failing only leaves a badge the next server fetch reconciles,
          // so drop it rather than flag the note as failed to sync.
          console.info(`Dropping queued operation id=${entry.id} markViewed ${endpoint} after ${attempts} failed attempts`);
          await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
          continue;
        }

        // Cap reached — dead-letter and continue. Record the
        // endpoint/body that was actually sent. HTTP 5xx
        // keeps its status; a non-HTTP throw or a client timeout records
        // PROCESSING_ERROR_STATUS (0).
        const deadLetterStatus = status ?? PROCESSING_ERROR_STATUS;
        const errorMessage = errorSummary(err);
        console.warn(
          `Dead-lettering queued operation id=${entry.id} after ${attempts} failed attempts ` +
            `(${deadLetterStatus === PROCESSING_ERROR_STATUS ? 'processing error' : `HTTP ${deadLetterStatus}`}): ${errorMessage}`,
        );
        const noteIds = targets();
        discardedOperations.push({ operation: entry.operation, endpoint, status: deadLetterStatus });
        await recordDeadLetter(db, entry, endpoint, body, deadLetterStatus, noteIds.length === 1 ? noteIds[0]! : null, {
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

  if (pullNoteIds.size > 0 && !stoppedOnConnectivity) {
    await pullTouchedNotes(db, pullNoteIds);
  }

  return { syncedNotes, discardedOperations, syncedSettings };
}

/**
 * Most notes {@link pullTouchedNotes} fetches after one drain. Each is a
 * sequential GET, so a drain after a long offline session must not turn into
 * hundreds of requests; the rest converge on the next list sync or SSE event.
 */
export const MAX_POST_DRAIN_NOTE_PULLS = 20;

/**
 * Whether a replayed write's response version reflects only this client's own
 * write. A version-guarded write the server accepted was based on exactly
 * `baseVersion` and bumps it by one at most (none for a no-op), so a version
 * in that range has no collaborator edit folded into it. Without a guard the
 * server applied the write on top of whatever version it held.
 */
function isOwnVersion(data: unknown, baseVersion: number | null): boolean {
  if (baseVersion === null || !hasStringId(data)) return false;
  const { version } = data as Note;
  return version === baseVersion || version === baseVersion + 1;
}

/**
 * Whether the queue holds an op for `noteId` other than entry `exceptEntryId`.
 * Reads the table rather than a snapshot taken when the drain started, so an
 * edit enqueued while the drain runs counts too.
 */
async function hasOtherQueuedOpForNote(
  db: SQLiteDatabase,
  noteId: string,
  exceptEntryId: number | undefined,
): Promise<boolean> {
  const row = await db.getFirstAsync<{ found: number }>(
    'SELECT 1 AS found FROM sync_queue_keys WHERE key = ? AND entry_id IS NOT ? LIMIT 1',
    [noteKey(noteId), exceptEntryId ?? null],
  );
  return row !== null;
}

/**
 * Whether the note has a failed change the user has not resolved (spec §8.4):
 * it is flagged `failed`, or a dead letter other than `exceptDeadLetterId`
 * still covers it (see {@link getDeadLetteredNoteIds}).
 */
async function hasUnresolvedFailure(
  db: SQLiteDatabase,
  noteId: string,
  exceptDeadLetterId: number | undefined,
): Promise<boolean> {
  const flagged = await db.getFirstAsync<{ failed: number }>(
    `SELECT 1 AS failed FROM notes WHERE id = ? AND sync_state = 'failed'`,
    [noteId],
  );
  return flagged !== null || (await getDeadLetteredNoteIds(db, exceptDeadLetterId)).has(noteId);
}

/**
 * Fetch the notes a drain touched whose local row no response settled
 * (#1262, spec §8.3). The device gets no SSE echo of its own writes, so
 * without this a row that fell behind stays behind until an unrelated sync
 * runs. Protected notes (queued op, unresolved failure) are skipped. Fetched one at a time: a batch would hold early
 * results while a newer snapshot lands, and its slowest timeout would finish
 * last and mark the server unreachable. Best effort: a failed fetch leaves the
 * note for the next background sync.
 */
async function pullTouchedNotes(db: SQLiteDatabase, noteIds: Set<string>): Promise<void> {
  const protectedIds = await getProtectedNoteIds(db);
  const toPull = [...noteIds].filter((id) => !protectedIds.has(id));
  if (toPull.length > MAX_POST_DRAIN_NOTE_PULLS) {
    console.info(
      `Pulling ${MAX_POST_DRAIN_NOTE_PULLS} of ${toPull.length} notes after the queue drain; the next sync reconciles the rest.`,
    );
  }
  for (const noteId of toPull.slice(0, MAX_POST_DRAIN_NOTE_PULLS)) {
    try {
      const since = snapshotMark();
      const note = await jot.notes.getById(noteId);
      await saveServerNote(db, note, since);
    } catch (err) {
      console.warn(`Failed to pull note id=${noteId} after the queue drain: ${errorSummary(err)}`);
    }
  }
}

export interface ServerResponseOptions {
  /** The queue entry this response answers, during a drain: not a later op. */
  exceptEntryId?: number;
  /** The dead letter being resolved: not an unresolved failure. */
  exceptDeadLetterId?: number;
  /**
   * The response version reflects only this client's write (see
   * isOwnVersion), so it is adopted even while the content is held back.
   */
  ownVersion?: boolean;
}

/**
 * Persist a note the server returned in answer to this client's own write on it
 * — an online hook's request, or the queue drain's replay (spec §8.3, #1262).
 * Returns true when the note was saved in full.
 *
 * - **Unresolved failed change:** take neither content nor version; the local
 *   row is what "Keep my version" forks from.
 * - **Another op queued for the note:** the response predates that edit (a
 *   create holds the content as of the first autosave), so take no content.
 *   Take the version only with `ownVersion`, so a chain of queued edits replays
 *   against the versions its own writes produced (#489) — a temporary
 *   exception to §8.3 until queued ops are merged (§8.5, #1268). A version that
 *   may carry a collaborator's edit is never adopted without its content.
 * - **Otherwise:** save it whole, which also brings in any collaborator edit
 *   made while the note was protected from snapshots. Its completed flags still
 *   go through localCompletedWrites like any server snapshot.
 *
 * The checks and the write share one transaction (saveNote's `guard`), so a
 * write serialized behind it cannot slip in between.
 */
export async function saveServerResponseNote(
  db: SQLiteDatabase,
  note: Note,
  options: ServerResponseOptions = {},
): Promise<boolean> {
  let saved = false;
  await saveNote(db, note, {
    // No keepLocalCompletedIds: the guard only lets the save through when no
    // other op, a queued completed op included, is waiting for the note.
    serverSnapshot: true,
    guard: async () => {
      if (await hasUnresolvedFailure(db, note.id, options.exceptDeadLetterId)) return false;
      if (await hasOtherQueuedOpForNote(db, note.id, options.exceptEntryId)) {
        if (options.ownVersion && typeof note.version === 'number') {
          await setLocalNoteVersion(db, note.id, note.version);
        }
        return false;
      }
      saved = true;
      return true;
    },
  });
  return saved;
}

/**
 * Reconciles a note's local rows against a server-authoritative full item list
 * (see reconcileLocalItems), keeping the completed value of every item a queued
 * completed op still has to replay (see {@link getQueuedCompletedItemIds}).
 * `write` is the localCompletedWrites token the list answers, if any;
 * `exceptEntryId` is the queue entry it answers during a drain.
 */
export async function reconcileServerItems(
  db: SQLiteDatabase,
  noteId: string,
  items: ServerItemInput[],
  options: { write?: number; exceptEntryId?: number } = {},
): Promise<void> {
  const queued = await getQueuedCompletedItemIds(db, noteId, options.exceptEntryId);
  await reconcileLocalItems(db, noteId, items, options.write ?? null, queued);
}

/**
 * Reconciles local item rows against a server-authoritative full item list
 * returned during queue drain (set-completed/delete): upserts
 * every returned item and prunes any local row absent from it. `items` is
 * `unknown` since it's a raw response body; anything other than an array
 * (e.g. a malformed/legacy response) is skipped rather than wiping the note's
 * items.
 */
async function reconcileItemsFromResponse(db: SQLiteDatabase, noteId: string, items: unknown, entryId: number): Promise<void> {
  if (!Array.isArray(items)) return;
  await reconcileServerItems(db, noteId, items as NoteItem[], { exceptEntryId: entryId });
}

/**
 * Re-fetch a note from the server and reconcile its share state during queue
 * drain. Used by share/unshare ops, which return 204 (no body) yet leave the
 * local note holding an optimistic `shared_with` (a synthetic `optimistic_<userId>`
 * row, or a row the unshare removed): a GET reconciles it to the server-assigned
 * share ids. Only the share columns are written (not a full saveNote) so a content
 * edit still queued for the same note isn't clobbered (the reason
 * saveServerResponseNote holds back a response while later ops are queued).
 * Best-effort: a failed fetch leaves the optimistic state for the next
 * background sync to reconcile.
 */
async function reconcileNoteFromServer(db: SQLiteDatabase, noteId: string | undefined): Promise<void> {
  if (!noteId) return;
  try {
    const data: unknown = await jot.notes.getById(noteId);
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
