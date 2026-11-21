import type { SQLiteDatabase } from 'expo-sqlite';
import axios from 'axios';
import api from '../api/client';
import { jot } from '../api/jot';
import { apiPaths, type GetNotesParams, type Note, type NoteItem, type UpdateMeRequest } from '@jot/shared';
import {
  markLocalNoteDeleted,
  permanentDeleteLocalNote,
  saveNoteInTx,
  saveServerSnapshotNotes,
  saveLabels,
  reconcileLocalItemsInTx,
  reconcileServerNotesScope,
  markNoteSyncFailed,
  clearNoteSyncFailed,
  patchLocalNoteImagesInTx,
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
  noteIdOfKey,
  noteKey,
  parseJsonObject,
  SETTINGS_KEY,
  type QueueKey,
} from './queueKeys';
import { withSerializedTransaction } from './transaction';
import { mergeQueuedOp } from './queueMerge';
import { rewriteLabelId, rewriteLabelKeys } from './labelIdRewrite';
import { notesWrittenSince, recordWriteLanded, snapshotMark, type SnapshotMark } from './snapshotGate';
import { recordOwnVersionStep, resolveOwnBaseVersion } from './ownVersions';
import { uploadNoteImage } from '../api/images';
import { deleteFileIfExists } from '../utils/fs';
import { cacheUploadedNoteImage } from '../utils/noteImageCache';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelayMs } from '../utils/backoff';
import type { Label, NoteShare } from '@jot/shared';

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
  | 'uploadImage'
  | 'markViewed';

interface QueueEntry {
  id: number;
  operation: QueueOperation;
  endpoint: string;
  method: string;
  body: string | null;
  created_at: string;
  /**
   * Count of entry-specific transient drain failures (issue #714), for
   * diagnostics. Defaults to 0 for rows written before migration 6 / by older
   * code paths.
   */
  attempts?: number;
  /** How many of `attempts` were non-HTTP processing errors: capped by {@link MAX_ENTRY_DRAIN_ATTEMPTS} (#1283). */
  processing_errors?: number;
  /** Device-clock epoch ms before which the drain does not resend the entry (#1301). */
  next_attempt_at?: number | null;
  /** Device-clock epoch ms of the first failure in the entry's current run of failures (#1301). */
  first_failed_at?: number | null;
  /** HTTP failures in the run counted toward giving up, at least {@link GIVE_UP_FAILURE_SPACING_MS} apart (#1301). */
  spaced_failures?: number;
  /** Device-clock epoch ms of the last failure counted in `spaced_failures`. */
  last_spaced_failure_at?: number | null;
}

/**
 * How many times processing a queue entry may throw a non-HTTP error (a
 * corrupted body, a local DB error) before it is dead-lettered (issue #714).
 * Such an error happens on the device, so retrying it later is unlikely to
 * help. An HTTP failure is given up on only under {@link GIVE_UP_AFTER_ATTEMPTS}
 * and {@link GIVE_UP_AFTER_MS} (#1301): a server outage must not turn queued
 * changes into failed ones (#1283). A best-effort op (markViewed, removeImage)
 * is dropped at the cap whatever failed, so it never holds back its note's edits.
 */
export const MAX_ENTRY_DRAIN_ATTEMPTS = 5;

/**
 * Wait before resending an entry after its first entry-specific failure; it
 * doubles with each further failure, up to {@link RETRY_WAIT_MAX_MS} (#1301,
 * Sync Loop Safety). A pass skips an entry still waiting.
 */
export const RETRY_WAIT_BASE_MS = BACKOFF_BASE_MS;
export const RETRY_WAIT_MAX_MS = BACKOFF_MAX_MS;

/**
 * A pass stops after this many failed sends in a row with no success between
 * them, whatever each entry's history (#1301): a server that fails every write
 * costs at most this many requests per pass.
 */
export const MAX_CONSECUTIVE_SEND_FAILURES = 3;

/**
 * An entry that keeps failing over HTTP is dead-lettered once its failure run
 * is at least {@link GIVE_UP_AFTER_MS} old *and* it has failed
 * {@link GIVE_UP_AFTER_ATTEMPTS} times at least
 * {@link GIVE_UP_FAILURE_SPACING_MS} apart (#1301). Time alone would give up on
 * a write that failed once before the app sat closed for days; attempts alone
 * would turn a short outage into failed changes (#1283). The spacing keeps the
 * quick early retries (and the waits a foreground clears) from reaching the
 * count in seconds: it takes minutes of failing. The local→server upgrade,
 * where the user waits on the screen, counts every attempt and has no time
 * condition.
 */
export const GIVE_UP_AFTER_ATTEMPTS = 5;
export const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
export const GIVE_UP_FAILURE_SPACING_MS = RETRY_WAIT_MAX_MS;

/** How long an entry waits after its `attempts`-th failure (#1301). */
export const retryWaitMs: (attempts: number) => number = backoffDelayMs;

/** dead_letter.status sentinel for a non-HTTP local processing error (issue #714). */
export const PROCESSING_ERROR_STATUS = 0;

export interface EnqueueParams {
  operation: QueueOperation;
  endpoint: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  /**
   * What the op writes (see queueKeys.ts): every note it changes, and every
   * label it names. Recorded in `sync_queue_keys`, which is what the protected
   * set and the per-note queue lookups read (#1282).
   */
  keys: readonly QueueKey[];
  /**
   * What the op depends on without writing it: a duplicate's source note. It
   * orders the op but does not protect the note or count as an op queued for it.
   */
  readKeys?: readonly QueueKey[];
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
 * The queue drain keeps a transient failure queued and retries it on a later
 * pass; a permanent one is discarded so it cannot wedge the queue, and either
 * dead-lettered or resolved by accepting server state (see
 * {@link acceptsServerStateOnRejection}).
 */
export function isTransientHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 401 || status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * Of the *transient* failures, which ones block the whole queue rather than
 * being specific to one entry (issue #714)? A global failure stops the drain
 * pass without charging the entry's attempt counter — every entry would fail
 * the same way — whereas an entry-specific transient failure holds back only
 * the entry and the later ops that share a key with it, and the pass goes on
 * (#1283).
 *
 * Global: a transport-level failure with no server response (network down or a
 * client timeout), plus statuses that apply queue-wide (401 needs re-auth, 408
 * request timeout, 429 rate limit). Entry-specific: a 5xx tied to this op's
 * payload, and any non-HTTP error thrown while processing the entry itself
 * (corrupted body, a local DB error) — those are charged to the entry.
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
 * Timeout for a write the drain sends: the only timeout a write has, since
 * every write goes through the queue (#1284, #1285). A write has no fallback
 * to hurry toward — it simply stays queued — and one that times out while the
 * server answers the probe holds back its note's later ops until it gets
 * through (#1211, #1283). So the budget is generous, letting a large write on
 * a slow but working link complete.
 */
export const QUEUED_WRITE_TIMEOUT_MS = 30000;

/** Request config for every replayed queue write. */
const REPLAY_REQUEST_CONFIG = { timeout: QUEUED_WRITE_TIMEOUT_MS } as const;

/** Timeout for the probe in {@link isGlobalDrainFailureProbed}. */
const SERVER_PROBE_TIMEOUT_MS = 5000;

/**
 * {@link isGlobalDrainFailure}, plus a decision on the ambiguous failures: when
 * the entry got a 502/503/504 or timed out client-side, probe the server with a
 * cheap read. If the server answers, the failure was specific to this entry, so
 * a request that always times out — at the proxy or at the client's own write
 * timeout (#1211) — holds back only the ops that depend on it while the rest of
 * the queue drains. If it doesn't, the server is down or unreachable: the
 * failure is global, charges nothing, and stops the pass.
 * A plain network error (no response, not a timeout) is global without a probe.
 *
 * Probed once per ambiguous failure, not once per pass: a server that goes
 * down mid-pass then stops the pass at the next failure instead of letting
 * every remaining entry run into the same timeout.
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
 * §6). `markViewed`: the unread badge just stays. Unlike the ops in
 * {@link SERVER_STATE_ON_REJECTION_OPERATIONS}, one that keeps failing
 * transiently is dropped too, so it never holds back its note's edits.
 */
const BEST_EFFORT_OPERATIONS: ReadonlySet<QueueOperation> = new Set([
  'removeImage',
  'markViewed',
]);

/**
 * Ops whose permanent rejection the drain resolves by accepting server state
 * rather than as a failed change (spec §8.4, #1285): their local value is not
 * worth a "Keep my version" fork, which copies a note's content. The row is
 * dropped and the note pulled, which undoes the local change.
 *
 * - Per-user state: trash, restore, permanent delete (pulled back if it still
 *   exists), and reorder (positions).
 * - Item structure and completed flags: a delete, reorder, check-off or bulk
 *   delete names items but carries no text the user typed.
 * - Label membership and sharing, including a collaborator leaving a note,
 *   whose local copy is already gone: the pull brings it back if the server
 *   kept the share.
 *
 * A per-user `update` (pin, colour, archive, collapse) and an `updateItem`
 * without text resolve the same way; see {@link acceptsServerStateOnRejection}.
 * Content — create, duplicate, convert, a title/content `update`, item text —
 * and label and settings changes are failed changes.
 */
const SERVER_STATE_ON_REJECTION_OPERATIONS: ReadonlySet<QueueOperation> = new Set([
  'delete',
  'restore',
  'permanentDelete',
  'reorder',
  'deleteItem',
  'reorderItems',
  'setItemsCompleted',
  'deleteCompletedItems',
  'addLabelToNote',
  'removeLabelFromNote',
  'share',
  'unshare',
]);

/** Whether a permanent rejection of this op resolves by accepting server state (see {@link SERVER_STATE_ON_REJECTION_OPERATIONS}). */
function acceptsServerStateOnRejection(operation: QueueOperation, body: Record<string, unknown> | undefined): boolean {
  if (SERVER_STATE_ON_REJECTION_OPERATIONS.has(operation)) return true;
  if (operation === 'update') return body !== undefined && !('content' in body) && !('title' in body);
  if (operation === 'updateItem') return body !== undefined && !('text' in body);
  return false;
}

/**
 * Operations whose 409 on replay means "already applied": the request names
 * the id it creates (or the share it adds), so a replay of one the server
 * already committed conflicts with itself. Any other op's 409 is a real
 * rejection: a version conflict, or a username already taken. `createLabel` is
 * resolved by name instead (see drainQueue).
 */
const CONFLICT_IDEMPOTENT_OPERATIONS: ReadonlySet<QueueOperation> = new Set([
  'create',
  'duplicate',
  'createItem',
  'share',
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
 * This is the common flaky-connection case: a replay times out client-side
 * *after* the server committed it, stays queued, and the next replay then
 * finds the note already trashed/restored/gone (server returns 404). Mirrors
 * the long-standing `removeImage` handling below, generalized to its siblings.
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

/** Called after a row is queued, with its operation, if known. */
type EnqueueListener = (operation?: QueueOperation) => void;

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
 * Notify enqueue listeners directly, bypassing `enqueueWrite`. Used by
 * imageUploadQueue.ts when it puts a failed upload back in the queue, or moves
 * queued uploads to another note, outside `enqueueWrite`.
 */
export function notifyEnqueueListeners(operation?: QueueOperation): void {
  for (const listener of enqueueListeners) {
    try {
      listener(operation);
    } catch (err) {
      console.warn('Enqueue listener failed:', err);
    }
  }
}

/**
 * Insert a single entry and its keys into the sync queue, bypassing the
 * local-mode guard and enqueue listeners. The local→server upgrade seed path
 * (seedReplayQueue) calls it directly, because local mode is still active while
 * the queue is being pre-populated for replay and `enqueueWrite`'s guard
 * would make that a no-op; everything else goes through `enqueueWrite`. The
 * row and its keys are separate statements: run it inside a transaction.
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
  await insertKeys(db, 'sync_queue_keys', result.lastInsertRowId, params);
}

/** Queue an op that has no local edit to apply: {@link enqueueWrite} with no local apply. */
export async function enqueueOperation(db: SQLiteDatabase, params: EnqueueParams): Promise<void> {
  await enqueueWrite(db, { localApply: async () => undefined, op: () => params });
}

/**
 * Queue a change to the user's profile or settings (`PATCH /users/me`). The
 * caller has already applied it to the in-memory session, which is where
 * settings live; a rejection is a failed change, and the drain then has the
 * session re-read so the app shows the server's values again.
 */
export async function enqueueSettingsUpdate(db: SQLiteDatabase, body: UpdateMeRequest): Promise<void> {
  await enqueueOperation(db, {
    operation: 'updateSettings',
    endpoint: apiPaths.usersMe,
    method: 'PATCH',
    keys: [SETTINGS_KEY],
    body: body as Record<string, unknown>,
  });
}

/** One write through the outbox: see {@link enqueueWrite}. */
export interface OutboxWrite<T> {
  /**
   * Applies the edit to SQLite. Runs inside the write's transaction, so it must
   * not open one of its own (withSerializedTransaction does not nest); its
   * result goes to `op`.
   */
  localApply: () => Promise<T>;
  /**
   * The queue rows that send the edit, in send order, built in the same
   * transaction from what `localApply` returned. Usually one; a write that
   * needs a label created first queues that label's create ahead of it.
   */
  op: (applied: T) => EnqueueParams | readonly EnqueueParams[];
}

/**
 * The only way a write reaches the server (spec §4.1, §8.2, #1284, #1285):
 * apply the edit to SQLite and insert its queue rows in one transaction, then
 * kick the drain. Nothing here touches the network; the drain sends the rows.
 *
 * Committed together, a snapshot that lands between the two cannot find the
 * edit without its row, and a process kill cannot leave an edit that nothing
 * will replay. Local mode keeps the edit and writes no row: there is no server
 * to send it to (#514). Resolves to what `localApply` returned.
 */
export async function enqueueWrite<T>(db: SQLiteDatabase, write: OutboxWrite<T>): Promise<T> {
  // Local mode has no server to sync to, so local writes are terminal the moment
  // they land in SQLite (#514): no row ever accumulates in `sync_queue`, and so
  // nothing can dead-letter purely because a server is absent.
  const queue = !isLocalModeActive();
  let applied!: T;
  const operations: QueueOperation[] = [];
  await withSerializedTransaction(db, async () => {
    applied = await write.localApply();
    if (!queue) return;
    for (const op of [write.op(applied)].flat()) {
      // An op that supersedes an earlier queued one is written into its row (spec §8.5).
      if (!(await mergeQueuedOp(db, op, sendingEntryByDb.get(db)))) await insertQueueEntry(db, op);
      operations.push(op.operation);
    }
  });
  for (const operation of operations) notifyEnqueueListeners(operation);
  return applied;
}

/** Queued ops, optionally leaving out image uploads. */
export async function getPendingCount(db: SQLiteDatabase, options?: { excludeUploads?: boolean }): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(
    options?.excludeUploads
      ? `SELECT COUNT(*) as count FROM sync_queue WHERE operation != 'uploadImage'`
      : 'SELECT COUNT(*) as count FROM sync_queue',
  );
  return row?.count ?? 0;
}

/** Head-of-line diagnostics for the sync queue (issue #714). */
export interface SyncQueueStats {
  pendingCount: number;
  /**
   * The oldest pending entry, or null when the queue is empty. `attempts`
   * shows how many times draining it has failed transiently; while it fails,
   * the later ops that share a key with it wait behind it (#1283).
   */
  head: { id: number; operation: QueueOperation; created_at: string; attempts: number } | null;
  /** Highest attempt count across all pending entries. */
  maxAttempts: number;
}

export const EMPTY_SYNC_QUEUE_STATS: SyncQueueStats = { pendingCount: 0, head: null, maxAttempts: 0 };

/**
 * Summarize the sync queue for the Diagnostics screen so a stuck entry is
 * legible: which op is oldest, how old it is, and how many transient failures
 * it (or any entry) has racked up (issue #714). A pending count alone can't
 * distinguish "healthy backlog" from "one failing entry holding back its note".
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

/** A queue row as the drain sends it, with what it touches. */
interface ClaimedEntry {
  entry: QueueEntry;
  /** Every key, read-only ones included: what the drain holds back behind an entry that fails (#1283). */
  keys: string[];
  /**
   * The notes the entry writes (its written `note:` keys): what a landing is
   * recorded for, what a dead letter links and flags failed, and what the
   * drain pulls afterwards.
   */
  writtenNoteIds: string[];
}

/**
 * The queue row the drain is sending, per database: never merged into
 * (spec §8.5). One drain pass runs at a time.
 */
const sendingEntryByDb = new WeakMap<SQLiteDatabase, number>();

/**
 * Where the last pass stopped after too many failed sends, per database
 * (#1301). The next pass leaves the entries up to it for the pass after,
 * so the writes past them get their turn: without this, the same few failing
 * entries come due together on every pass and stop it before it reaches
 * anything behind them.
 */
const resumeAfterByDb = new WeakMap<SQLiteDatabase, number>();

/**
 * Read queue row `entryId` as it is now, with its keys, and record it as the
 * row being sent, in one serialized transaction: a merge at enqueue (spec
 * §8.5) committed before this is sent with the row, and one after it appends a
 * new row instead (see queueMerge.ts). Null when the row is gone.
 */
async function claimQueueEntry(db: SQLiteDatabase, entryId: number): Promise<ClaimedEntry | null> {
  let claimed = null as ClaimedEntry | null;
  await withSerializedTransaction(db, async () => {
    const rows = await db.getAllAsync<QueueEntry & { key: string | null; read_only: number | null }>(
      `SELECT q.*, k.key, k.read_only FROM sync_queue q
         LEFT JOIN sync_queue_keys k ON k.entry_id = q.id
       WHERE q.id = ?`,
      [entryId],
    );
    const [first] = rows;
    if (first === undefined) return;
    // The joined key columns ride along unread.
    const entry: QueueEntry = first;
    const keys: string[] = [];
    const writtenNoteIds: string[] = [];
    for (const { key, read_only: readOnly } of rows) {
      if (key === null) continue;
      keys.push(key);
      const noteId = readOnly === 0 ? noteIdOfKey(key) : null;
      if (noteId !== null) writtenNoteIds.push(noteId);
    }
    sendingEntryByDb.set(db, entryId);
    claimed = { entry, keys, writtenNoteIds };
  });
  return claimed;
}

/**
 * Charge an entry's failed drain attempt to its counters (issue #714), start
 * its wait before the next send and, on its first failure, its failure run
 * (#1301). An HTTP failure at least {@link GIVE_UP_FAILURE_SPACING_MS} after
 * the last one counted also counts toward giving up (`spacedFailures`).
 * `capped` says whether a non-HTTP processing error has reached
 * {@link MAX_ENTRY_DRAIN_ATTEMPTS} on its own count; whether an HTTP failure is
 * given up on is the caller's call.
 */
async function chargeEntryFailure(
  db: SQLiteDatabase,
  entry: QueueEntry,
  err: unknown,
  now: number,
): Promise<{
  attempts: number;
  processingErrors: number;
  capped: boolean;
  nextAttemptAt: number;
  firstFailedAt: number;
  spacedFailures: number;
}> {
  const attempts = (entry.attempts ?? 0) + 1;
  const processingError = !axios.isAxiosError(err);
  const processingErrors = (entry.processing_errors ?? 0) + (processingError ? 1 : 0);
  const nextAttemptAt = now + retryWaitMs(attempts);
  const firstFailedAt = entry.first_failed_at ?? now;
  const lastSpaced = entry.last_spaced_failure_at ?? null;
  const spaced = !processingError && (lastSpaced === null || now - lastSpaced >= GIVE_UP_FAILURE_SPACING_MS);
  const spacedFailures = (entry.spaced_failures ?? 0) + (spaced ? 1 : 0);
  await db.runAsync(
    `UPDATE sync_queue SET attempts = ?, processing_errors = ?, next_attempt_at = ?, first_failed_at = ?,
       spaced_failures = ?, last_spaced_failure_at = ?
     WHERE id = ?`,
    [attempts, processingErrors, nextAttemptAt, firstFailedAt, spacedFailures, spaced ? now : lastSpaced, entry.id],
  );
  return {
    attempts,
    processingErrors,
    capped: processingError && processingErrors >= MAX_ENTRY_DRAIN_ATTEMPTS,
    nextAttemptAt,
    firstFailedAt,
    spacedFailures,
  };
}

/**
 * Let every queued entry be sent on the next pass, whatever its wait (#1301).
 * A reconnect or foreground calls this, so the queue recovers at once after an
 * outage rather than when the longest wait runs out. Failure runs are kept.
 */
export async function clearQueuedWriteWaits(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('UPDATE sync_queue SET next_attempt_at = NULL WHERE next_attempt_at IS NOT NULL');
}

/**
 * Device-clock epoch ms since which the longest-failing queued entry has been
 * failing, or null when no entry is in a failure run (#1301). Drives the
 * sync-error banner.
 */
export async function getOldestFailingSince(db: SQLiteDatabase): Promise<number | null> {
  const row = await db.getFirstAsync<{ since: number | null }>('SELECT MIN(first_failed_at) AS since FROM sync_queue');
  return row?.since ?? null;
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
     WHERE dead_letter_id = ? AND read_only = 0 AND ${keyKindCondition('key', 'note')}`,
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
     WHERE read_only = 0 AND ${keyKindCondition('key', 'note')}`,
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
     WHERE d.note_id IS NULL AND d.id IS NOT ? AND k.read_only = 0 AND ${keyKindCondition('k.key', 'note')}`,
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
  // Nothing to clear on a note that is not flagged; skip the dead-letter scan.
  const flagged = await db.getFirstAsync<{ failed: number }>(
    `SELECT 1 AS failed FROM notes WHERE id = ? AND sync_state = 'failed'`,
    [noteId],
  );
  if (flagged === null) return;
  if ((await getDeadLetteredNoteIds(db, exceptDeadLetterId)).has(noteId)) return;
  await clearNoteSyncFailed(db, noteId);
}

/**
 * Notes that server-sourced writes must leave untouched: those with a pending
 * queue op (#487), queued image uploads included (#1288), those with a failed
 * image upload awaiting Retry or Dismiss (#1279), plus
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
 * Notes with a failed upload in `pending_image_uploads`. The photo was never
 * sent and has no `sync_queue` row, and the upload row cascade-deletes with its
 * note, so pruning the note would drop the photo before the user retries it
 * (#1279). A queued upload is a `sync_queue` row, covered by its key (#1288).
 */
async function getNoteIdsWithPendingUploads(db: SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ note_id: string }>(
    'SELECT DISTINCT note_id FROM pending_image_uploads',
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
 * Batch counterpart of {@link saveServerNote}. The skip set is read once,
 * inside the write's transaction.
 */
export async function saveServerNotes(db: SQLiteDatabase, notes: Note[], since: SnapshotMark): Promise<void> {
  await saveServerSnapshotNotes(db, notes, () => readSnapshotSkips(db, since));
}

/**
 * Labels with a queued `createLabel`, `renameLabel` or `deleteLabel` op: the
 * label-store counterpart of {@link getProtectedNoteIds}. Until the op drains,
 * a canonical GET /labels predates it: it lacks a label created offline (its
 * client id *is* the server id, #546), still has the old name of one renamed,
 * and still lists one deleted. So {@link saveServerLabels} neither upserts nor
 * prunes them.
 */
export async function getPendingLabelIds(db: SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT DISTINCT ${keyIdExpression('k.key', 'label')} AS id FROM sync_queue_keys k
       JOIN sync_queue q ON q.id = k.entry_id
     WHERE q.operation IN ('createLabel', 'renameLabel', 'deleteLabel') AND ${keyKindCondition('k.key', 'label')}`,
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Persist a canonical server label list into the store (background sync), pruning
 * any local label the server no longer has while leaving labels with a queued
 * create, rename or delete untouched (see {@link getPendingLabelIds}). The
 * protected set is read inside the write's transaction, so an op queued while
 * the list was in flight still counts. This is what makes an empty label
 * created/deleted on another device converge locally (issue #691).
 */
export async function saveServerLabels(db: SQLiteDatabase, labels: Label[]): Promise<void> {
  await saveLabels(db, labels, { readSkipLabelIds: () => getPendingLabelIds(db) });
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

/** The body of a queued `uploadImage` row (#1288). `id` is the image's client ID, so a replay is idempotent. */
export interface ImageUploadBody {
  id: string;
  local_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
}

/** A queued upload's body, or null when the stored one is malformed. */
export function parseImageUploadBody(body: Record<string, unknown> | null | undefined): ImageUploadBody | null {
  if (!body) return null;
  const { id, local_path: localPath, filename, mime_type: mimeType, size_bytes: sizeBytes } = body;
  if (typeof id !== 'string' || typeof localPath !== 'string' || typeof filename !== 'string' || typeof mimeType !== 'string') {
    return null;
  }
  return {
    id,
    local_path: localPath,
    filename,
    mime_type: mimeType,
    size_bytes: typeof sizeBytes === 'number' ? sizeBytes : null,
  };
}

/**
 * Move a rejected upload to `pending_image_uploads` as an error tile (Retry /
 * Dismiss) instead of dead-lettering it. If the note is gone locally, the file
 * is deleted instead. If the row is already gone (dismissed or moved to another
 * note while the request was in flight), nothing changes.
 */
async function flagImageUploadFailed(
  db: SQLiteDatabase,
  entry: QueueEntry,
  noteId: string,
  upload: ImageUploadBody,
  message: string,
  counts: { attempts: number; processingErrors: number },
): Promise<void> {
  let owned = false;
  let flagged = false;
  await withSerializedTransaction(db, async () => {
    owned = (await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id])).changes > 0;
    if (!owned) return;
    const result = await db.runAsync(
      `INSERT INTO pending_image_uploads
         (id, note_id, local_path, filename, mime_type, size_bytes, status, error_message, created_at, attempts, processing_errors)
       SELECT ?, id, ?, ?, ?, ?, 'error', ?, ?, ?, ? FROM notes WHERE id = ?
       ON CONFLICT(id) DO UPDATE SET status = 'error', error_message = excluded.error_message`,
      [
        upload.id,
        upload.local_path,
        upload.filename,
        upload.mime_type,
        upload.size_bytes,
        message,
        entry.created_at,
        counts.attempts,
        counts.processingErrors,
        noteId,
      ],
    );
    flagged = result.changes > 0;
  });
  if (owned && !flagged) deleteFileIfExists(upload.local_path);
}

/**
 * Drop a queued upload for good: its row and its file. The file goes only if
 * this removed the row: one moved to another note meanwhile shares the file.
 */
async function discardImageUpload(db: SQLiteDatabase, entry: QueueEntry, upload: ImageUploadBody | null): Promise<void> {
  const result = await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
  if (upload && result.changes > 0) deleteFileIfExists(upload.local_path);
}

export interface DiscardedOperation {
  operation: QueueOperation;
  endpoint: string;
  /**
   * The status that caused the discard: a permanent (non-transient 4xx) HTTP
   * status, or PROCESSING_ERROR_STATUS (0) for a non-HTTP local processing
   * error that recurred MAX_ENTRY_DRAIN_ATTEMPTS times (issue #714). A write
   * given up on after failing over HTTP for too long (#1301) holds its last
   * status: a 5xx, or 0 for a client timeout.
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
  /**
   * True if at least one `updateSettings` operation landed or was rejected:
   * either way the server's settings may differ from the optimistic ones the
   * app shows, so the caller re-reads them.
   */
  syncedSettings: boolean;
  /**
   * Entries this pass loaded that are still queued: waiting, held back, failed
   * transiently, or not reached after a stop. Rows queued while the pass ran
   * are not counted; they are new work (#1284).
   */
  leftBehind: number;
  /**
   * The pass stopped on a connectivity failure, which charges no entry: the
   * server is down or unreachable, or wants re-auth or less traffic. The
   * caller backs off the whole queue.
   */
  stoppedOnConnectivity: boolean;
  /**
   * The pass stopped after {@link MAX_CONSECUTIVE_SEND_FAILURES} failed sends
   * in a row (#1301): entries behind them were not reached.
   */
  stoppedOnFailures: boolean;
  /**
   * Device-clock epoch ms at which the earliest entry this pass waited on or
   * charged may be sent again, or null when none is waiting (#1301). Entries
   * held back behind another are left out: they wait for it, not for a time.
   */
  nextAttemptAt: number | null;
}

/** How a drain pass runs. */
export interface DrainOptions {
  /**
   * The local→server upgrade's drain (#1301): every entry is sent whatever its
   * wait or where the last pass stopped, since the upgrade screen paces its own
   * passes, and a write that keeps
   * failing over HTTP is given up on after {@link GIVE_UP_AFTER_ATTEMPTS}
   * attempts, spaced or not, with no time condition, since the user is waiting
   * on that screen.
   */
  upgrade?: boolean;
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
    `INSERT OR IGNORE INTO dead_letter_keys (dead_letter_id, key, read_only)
     SELECT ?, key, read_only FROM sync_queue_keys WHERE entry_id = ?`,
    [result.lastInsertRowId, entry.id],
  );
}

/**
 * Holds on the drain, per database: while any is in place, a pass that starts
 * sends nothing, and a running pass stops before its next entry. Taken by a
 * one-shot action after which the queue must not reach the server, namely
 * deleting the account (#1317): once the server has deleted it, every queued
 * write would only 401, so the drain must not run between the delete and the
 * wipe of the queue.
 */
const drainHoldsByDb = new WeakMap<SQLiteDatabase, number>();
/** The passes running per database, for {@link holdDrain} to wait on. */
const runningDrainsByDb = new WeakMap<SQLiteDatabase, Set<Promise<DrainResult>>>();

function isDrainHeld(db: SQLiteDatabase): boolean {
  return (drainHoldsByDb.get(db) ?? 0) > 0;
}

/**
 * Stops the drain of `db` from sending anything, and resolves once no pass is
 * running, so every request a pass sent went out before the caller's next one.
 * A running pass stops before its next entry; the request it has in flight
 * ends within its finite timeout.
 *
 * Call the returned release once when done. `resume` asks for a drain at once
 * (through the enqueue listeners), for when the queue still matters, say the
 * action failed; leave it off when the queue is gone or must stay unsent.
 */
export async function holdDrain(db: SQLiteDatabase): Promise<(options?: { resume?: boolean }) => void> {
  drainHoldsByDb.set(db, (drainHoldsByDb.get(db) ?? 0) + 1);
  let released = false;
  const release = (options?: { resume?: boolean }): void => {
    if (released) return;
    released = true;
    const holds = (drainHoldsByDb.get(db) ?? 1) - 1;
    if (holds > 0) drainHoldsByDb.set(db, holds);
    else drainHoldsByDb.delete(db);
    if (options?.resume && holds <= 0) notifyEnqueueListeners();
  };
  // allSettled never rejects: a pass that fails has still stopped sending.
  await Promise.allSettled([...(runningDrainsByDb.get(db) ?? [])]);
  return release;
}

/** A pass that found the drain held: nothing sent, the queue as it was. */
async function heldDrainResult(db: SQLiteDatabase): Promise<DrainResult> {
  const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sync_queue');
  return {
    syncedNotes: [],
    discardedOperations: [],
    syncedSettings: false,
    leftBehind: row?.count ?? 0,
    stoppedOnConnectivity: false,
    stoppedOnFailures: false,
    nextAttemptAt: null,
  };
}

/**
 * Drain the sync queue in one pass, in insertion order, FIFO per key: an op is
 * sent only after every earlier op that shares a key with it (a note, a label,
 * the settings; see queueKeys.ts). For each entry, make the corresponding API
 * call. On success, delete the entry. On a permanent client error
 * (non-transient 4xx), discard the entry and continue: idempotent 409 conflicts
 * resolve silently, while every other permanent status dead-letters the op
 * (preserved in the `dead_letter` table with the affected note flagged
 * `sync_state = 'failed'`) so the optimistic edit isn't lost (#492).
 *
 * Transient failures split two ways (issue #714):
 *   - *Global* connectivity failures — no server response (a network error, or a
 *     client timeout / gateway status while the server does not answer a probe)
 *     or a whole-queue-blocking status (401 re-auth, 408, 429 rate-limit) — stop
 *     the pass without charging the entry, since every entry would fail the
 *     same way; the remainder retries on the next pass.
 *   - *Entry-specific* failures — a 5xx tied to this op's payload, a client
 *     timeout or gateway status while the server answers the probe, or a
 *     non-HTTP error thrown while processing this entry — increment the entry's
 *     `attempts` counter. The entry stays queued, its keys join this pass's
 *     *blocked set*, and the pass goes on (#1283). A later op that shares a key
 *     with the blocked set is skipped without being sent, and its own keys join
 *     the set too, so a chain of dependent ops stays in order while unrelated
 *     notes drain. The entry then waits its own retry delay
 *     ({@link retryWaitMs}, #1301): a pass skips it until it is due, holding
 *     back its dependents the same way, and OfflineContext schedules the next
 *     pass for the earliest entry due ({@link DrainResult.nextAttemptAt}). A
 *     non-HTTP processing error is dead-lettered once it has recurred
 *     MAX_ENTRY_DRAIN_ATTEMPTS times; an HTTP failure only once its failure
 *     run is {@link GIVE_UP_AFTER_MS} old and it has failed
 *     {@link GIVE_UP_AFTER_ATTEMPTS} times minutes apart, so an outage does not
 *     turn queued changes into failed ones.
 *
 * A pass stops after {@link MAX_CONSECUTIVE_SEND_FAILURES} failed sends in a
 * row, so a server that fails every write costs a bounded number of requests
 * per pass (#1301).
 *
 * An `uploadImage` row is sent as multipart rather than JSON, and waits while
 * its note is not confirmed on the server. A permanent rejection flags it for
 * Retry or Dismiss in the gallery instead of dead-lettering it, unless its note
 * is gone (404/403), which drops it (#1288).
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
export function drainQueue(db: SQLiteDatabase, options: DrainOptions = {}): Promise<DrainResult> {
  // While held (see holdDrain), nothing is sent.
  if (isDrainHeld(db)) return heldDrainResult(db);
  const pass = drainPass(db, options);
  let running = runningDrainsByDb.get(db);
  if (!running) {
    running = new Set();
    runningDrainsByDb.set(db, running);
  }
  const passes = running;
  passes.add(pass);
  const done = (): void => {
    passes.delete(pass);
  };
  pass.then(done, done);
  return pass;
}

async function drainPass(db: SQLiteDatabase, options: DrainOptions): Promise<DrainResult> {
  // Only the ids: each row and its keys are read when the pass reaches it (see
  // claimQueueEntry), since a merge at enqueue or a label-id rewrite may have
  // changed them since this load.
  const entryIds = (await db.getAllAsync<{ id: number }>('SELECT id FROM sync_queue ORDER BY id ASC'))
    .map((row) => row.id);
  // Keys of the entries this pass held back: one that failed transiently, and
  // every later one that shares a key with it (#1283).
  const blockedKeys = new Set<string>();

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
  // Failed sends since the last one that got through (#1301): the pass stops
  // once it reaches MAX_CONSECUTIVE_SEND_FAILURES.
  let consecutiveSendFailures = 0;
  let nextAttemptAt: number | null = null;
  const noteWait = (at: number): void => {
    nextAttemptAt = nextAttemptAt === null ? at : Math.min(nextAttemptAt, at);
  };
  let syncedSettings = false;

  // The upgrade sends every entry on every pass, as it ignores waits: its
  // screen paces the passes and needs each failing entry charged each time.
  const resumeAfter = options.upgrade ? 0 : resumeAfterByDb.get(db) ?? 0;
  // The last entry this pass reached: where the next one resumes if this one
  // stops on failed sends.
  let lastVisitedId = 0;

  for (const entryId of entryIds) {
    if (consecutiveSendFailures >= MAX_CONSECUTIVE_SEND_FAILURES) break;
    // Held since the pass started (see holdDrain): the rest stays queued.
    if (isDrainHeld(db)) break;
    settledThisEntry = new Set<string>();
    // Sent as it is now, and closed to merges until the next entry (spec §8.5).
    // A row gone since the load (an upload moved or dismissed) is skipped.
    const claimed = await claimQueueEntry(db, entryId);
    if (claimed === null) continue;
    const { entry, keys, writtenNoteIds } = claimed;
    lastVisitedId = entry.id;
    // Declared outside the try so the catch can dead-letter using the endpoint
    // and body that were actually sent to the server.
    let endpoint = entry.endpoint;
    let body: Record<string, unknown> | undefined;
    // Flipped true the instant the server request returns 2xx. After that point a
    // throw is a *local reconciliation* failure, not a failed write, so it must
    // not retry or dead-letter the entry (issue #714).
    let requestLanded = false;
    // The note this replay version-guarded, and the version its response
    // reports, when that version is its own (see rebaseQueuedEdits).
    let ownVersionStep: OwnVersionStep | null = null;
    // Deletes the landed entry and rebases the edits behind it, inside the
    // caller's transaction. A note this response settled has no other queued
    // op, so only the in-memory step is left to record.
    const removeLandedEntry = async (): Promise<void> => {
      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      if (!ownVersionStep) return;
      if (settledThisEntry.has(ownVersionStep.noteId)) recordOwnVersionStep(db, ownVersionStep.noteId, ownVersionStep.from, ownVersionStep.to);
      else await rebaseQueuedEdits(db, ownVersionStep);
    };
    const uploadNoteId = entry.operation === 'uploadImage' ? writtenNoteIds[0] : undefined;
    try {
      // Still waiting after an earlier failure (#1301): not sent, not charged,
      // and the ops that depend on it keep waiting behind it.
      const waitUntil = entry.next_attempt_at ?? 0;
      if (!options.upgrade && waitUntil > Date.now()) {
        for (const key of keys) blockedKeys.add(key);
        noteWait(waitUntil);
        continue;
      }

      // Up to where the last pass stopped on failed sends: left for the next
      // pass, which starts from the front again, so the writes past them are
      // reached first. Their keys hold back what depends on them, so order
      // holds.
      if (entry.id <= resumeAfter) {
        for (const key of keys) blockedKeys.add(key);
        noteWait(Date.now());
        continue;
      }

      if (entry.operation === 'uploadImage') {
        // Wait while the note is not confirmed on the server (pending or
        // failed create), or the upload would 404 and be lost (#834). The
        // note's other ops are not held back.
        const note = uploadNoteId === undefined
          ? null
          : await db.getFirstAsync<{ sync_state: string }>('SELECT sync_state FROM notes WHERE id = ?', [uploadNoteId]);
        if (note === null) {
          console.info(`Dropping queued image upload id=${entry.id}: its note is gone locally`);
          await discardImageUpload(db, entry, parseImageUploadBody(parseJsonObject(entry.body)));
          continue;
        }
        if (note.sync_state !== 'synced') continue;
      }

      // If this op targets a note whose create was just dead-lettered, replaying
      // it against a note the server never got is pointless — drop it (the note
      // stays flagged failed) rather than round-tripping to a guaranteed 404.
      if (abandonedCreateNoteIds.size > 0) {
        const touched = writtenNoteIds;
        if (touched.length > 0 && touched.every((id) => abandonedCreateNoteIds.has(id))) {
          console.warn(
            `Dropping queued operation id=${entry.id} (${entry.operation}): its note's create was dead-lettered.`,
          );
          await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
          continue;
        }
      }

      // An earlier op this op depends on failed this pass: it waits behind it,
      // and so does every later op that depends on this one.
      if (keys.some((key) => blockedKeys.has(key))) {
        for (const key of keys) blockedKeys.add(key);
        continue;
      }

      if (entry.body) {
        body = JSON.parse(entry.body) as Record<string, unknown>;
      }

      // The base_version this replay was sent with, if it was version-guarded:
      // a convert, or an update that touches content.
      let baseVersion: number | null = null;
      const guardedNoteId = writtenNoteIds[0];
      if (guardedNoteId !== undefined && body !== undefined && (
        entry.operation === 'convertNoteType'
        || (entry.operation === 'update' && ('content' in body || 'title' in body)))) {
        if (typeof body.base_version === 'number') {
          // The version the editor was showing, stored at enqueue (#1277,
          // #1284), advanced past this device's own edits that landed since
          // (rebaseQueuedEdits rewrites the row too, for after a restart).
          baseVersion = resolveOwnBaseVersion(db, guardedNoteId, body.base_version);
          body.base_version = baseVersion;
        } else {
          // A row queued before edits stored their base: resolve it from the
          // note's local version at replay time, as the drain used to (#489).
          // applyResponse below advances that version after each drained
          // edit, so a chain of such edits replays against the right base.
          baseVersion = await getLocalNoteVersion(db, guardedNoteId);
          if (baseVersion !== null) body.base_version = baseVersion;
        }
      }
      if (uploadNoteId !== undefined) {
        const upload = parseImageUploadBody(body);
        if (!upload) throw new Error('Malformed image upload body');
        const image = await uploadNoteImage(uploadNoteId, {
          uri: upload.local_path,
          name: upload.filename,
          mimeType: upload.mime_type,
          sizeBytes: upload.size_bytes ?? undefined,
        }, undefined, undefined, upload.id);
        requestLanded = true;
        // Images bump updated_at but not version.
        await withSerializedTransaction(db, async () => {
          await patchLocalNoteImagesInTx(
            db,
            uploadNoteId,
            (images) => images.some((img) => img.id === image.id) ? images : [...images, image],
            image.created_at,
          );
          await removeLandedEntry();
        });
        // The queue's copy becomes the cached original (it is deleted if that fails).
        await cacheUploadedNoteImage(image.id, upload.local_path, { move: true });
        // Ops it followed withheld their responses while it was queued; the
        // pull catches the note up once nothing is left queued for it.
        pullNoteIds.add(uploadNoteId);
        consecutiveSendFailures = 0;
        continue;
      }

      // From here the server may hold the create even if no response comes
      // back, so no later edit is folded into it (queueMerge.ts). Recorded
      // durably: the row can outlive the process.
      if (entry.operation === 'create') {
        await withSerializedTransaction(db, async () => {
          await db.runAsync('UPDATE sync_queue SET send_attempted = 1 WHERE id = ?', [entry.id]);
        });
      }
      let response: { data?: unknown } | undefined;
      if (entry.method === 'POST') {
        response = await api.post(endpoint, body, REPLAY_REQUEST_CONFIG);
      } else if (entry.method === 'PATCH') {
        response = await api.patch(endpoint, body, REPLAY_REQUEST_CONFIG);
      } else if (entry.method === 'DELETE') {
        response = await api.delete(endpoint, REPLAY_REQUEST_CONFIG);
      }
      requestLanded = true;
      consecutiveSendFailures = 0;
      const data = response?.data;
      const responseNote = hasStringId(data) ? data as Note : null;

      // A version-guarded write (only an update or a convert sets baseVersion)
      // the server accepted at baseVersion: its version is this device's own,
      // so content edits queued against the same base are rebased onto it (#1284).
      if (baseVersion !== null && responseNote && isOwnVersion(responseNote, baseVersion)) {
        ownVersionStep = { noteId: responseNote.id, from: baseVersion, to: responseNote.version };
      }

      // Share and unshare return 204: their share state needs a GET, which
      // must not run inside the landing transaction.
      const shares = entry.operation === 'share' || entry.operation === 'unshare'
        ? await fetchNoteShares(writtenNoteIds[0])
        : null;

      // Applies a replayed write's note response (see saveServerResponseNote).
      const applyResponse = async (ownVersion: boolean): Promise<Note | null> => {
        if (!responseNote) return null;
        if (!(await saveServerResponseNoteInTx(db, responseNote, { exceptEntryId: entry.id, ownVersion }))) return null;
        settledThisEntry.add(responseNote.id);
        return responseNote;
      };

      // The response and the row's removal commit together (spec §8.3, #1284):
      // there is no moment where the write has landed but neither its row nor
      // its result protects the note.
      let syncedNote: Note | null = null;
      await withSerializedTransaction(db, async () => {
        switch (entry.operation) {
          case 'create':
          case 'duplicate': {
            // The server keeps the client-supplied `id`, so the id is stable —
            // adopt the canonical note (server item ids etc.) and clear the
            // pending-create marker. A note the server only just created is at
            // version 1, as the local row already is, so taking its version
            // changes nothing. A duplicate's content is the server's copy of
            // its source, which may differ from the device's (spec §8.1).
            const clientId = body?.id as string | undefined;
            if (clientId && responseNote) {
              syncedNote = await applyResponse(true);
              await clearNotePendingCreate(db, clientId);
            }
            break;
          }
          case 'addLabelToNote':
          case 'removeLabelFromNote':
            // The server returns the updated note; persist it so labels_json
            // reflects the server's label ids. Labels are not version-guarded,
            // so its version may carry a collaborator's edit.
            await applyResponse(false);
            break;
          case 'setItemsCompleted':
          case 'deleteCompletedItems':
            // endpoints: .../items/set-completed and
            // .../items/delete. Both return the note's full, authoritative
            // item list (the delete endpoint's is the post-delete remainder), so
            // reconcile every field and prune any local row absent from it —
            // not just patch `completed` on the rows present — otherwise a
            // stale local row (e.g. leftover parent_id/position from an earlier
            // partial sync, or one deleted by another session while this
            // device was offline) never gets corrected. Taken only under the
            // rule saveServerResponseNote applies: with another op queued, or
            // a failed change unresolved, the list predates the local rows
            // (spec §8.3), so they stay and the note is pulled.
            await reconcileItemsFromResponseInTx(db, endpoint.split('/')[2]!, data, entry.id);
            break;
          case 'share':
          case 'unshare':
            if (shares) await updateLocalNoteShares(db, shares.id, shares);
            break;
          case 'convertNoteType':
            // Returns the full converted note (authoritative version,
            // updated_at, and item ids).
            await applyResponse(ownVersionStep !== null);
            break;
          case 'update':
            // A per-user change (pinned, color, …) is not version-guarded, so its
            // response version may include a collaborator's edit this device has
            // not seen; adopting it would let the next content edit pass the
            // base_version check and overwrite that edit (#1262).
            if (writtenNoteIds[0] !== undefined) await applyResponse(ownVersionStep !== null);
            break;
          case 'updateSettings':
            syncedSettings = true;
            break;
          default:
            break;
        }

        await removeLandedEntry();

        // The write landed: if this note was carrying a prior failure that no
        // dead letter still records, clear it so it resumes syncing from the
        // server normally (#492). An unresolved dead letter keeps it (#1263).
        for (const noteId of writtenNoteIds) {
          await clearNoteSyncFailedIfResolved(db, noteId);
        }
      });
      if (syncedNote) syncedNotes.push(syncedNote);

      // The API client already recorded this landing from the request, except
      // for a removeImage replay: it sends no body, so its note id is only
      // here (#1265). Recording a landing twice would skip a snapshot fetched
      // between the two.
      if (entry.operation === 'removeImage') recordWriteLanded(writtenNoteIds);

      for (const noteId of writtenNoteIds) {
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
        if (entry.operation === 'removeImage') recordWriteLanded(writtenNoteIds);
        // The landing transaction rolled back, rebase and create bookkeeping
        // included: the edits queued at this write's base would otherwise replay
        // against a version its own landing has left, and a create would stay
        // pending with nothing left to clear it. Pull the notes afterwards for
        // the response this entry could not apply.
        await withSerializedTransaction(db, async () => {
          await removeLandedEntry();
          if (entry.operation === 'create' || entry.operation === 'duplicate') {
            for (const noteId of writtenNoteIds) await clearNotePendingCreate(db, noteId);
          }
        });
        if (uploadNoteId !== undefined) {
          const upload = parseImageUploadBody(body);
          // The image landed under its client ID, so the copy is its original.
          if (upload) await cacheUploadedNoteImage(upload.id, upload.local_path, { move: true });
        }
        if (entry.operation !== 'delete' && entry.operation !== 'permanentDelete') {
          for (const noteId of writtenNoteIds) pullNoteIds.add(noteId);
        }
        continue;
      }

      const status = axios.isAxiosError(err) ? err.response?.status : undefined;

      // `isTransientHttpStatus(undefined)` is true, so reaching this branch
      // guarantees `status` is a defined, non-transient HTTP code.
      if (status !== undefined && !isTransientHttpStatus(status)) {
        // Permanent client error (e.g. 400/403/404/409/422) — replaying will
        // never succeed, so discard the entry and continue rather than letting one
        // bad operation wedge the whole queue indefinitely. The server
        // answered it, so it is not a failed send (#1301).
        consecutiveSendFailures = 0;
        discardedOperations.push({ operation: entry.operation, endpoint, status });

        if (uploadNoteId !== undefined) {
          const upload = parseImageUploadBody(body);
          if (status === 404 || status === 403 || !upload) {
            console.info(`Dropping queued image upload id=${entry.id} (HTTP ${status}): its note is gone`);
            await discardImageUpload(db, entry, upload);
          } else {
            console.warn(`Image upload id=${entry.id} was rejected (HTTP ${status}); flagging it for retry or dismiss`);
            await flagImageUploadFailed(db, entry, uploadNoteId, upload, axios.isAxiosError(err) ? err.message : 'Upload failed', {
              attempts: entry.attempts ?? 0,
              processingErrors: entry.processing_errors ?? 0,
            });
          }
          continue;
        }
        if (entry.operation === 'updateSettings') syncedSettings = true;

        // A 409 from a create-like replay is an idempotent already-applied
        // conflict (the original request already committed): the local state is
        // correct, so resolve it silently (see CONFLICT_IDEMPOTENT_OPERATIONS).
        // Any other 409 is a real rejection: an `update` or `convertNoteType`
        // conflict means the note changed on another device since the edit's
        // base_version (#489), and an `updateSettings` one that the username is
        // taken. Those go through the same split as any other permanent status
        // (#492, #1285), so a content edit is preserved and surfaced via the
        // failed-changes banner instead of being silently dropped.
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
          (status === 409 && CONFLICT_IDEMPOTENT_OPERATIONS.has(entry.operation)) ||
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
                await withSerializedTransaction(db, async () => {
                  await rewriteLabelId(db, clientLabelId, serverLabel.id, serverLabel);
                  await rewriteLabelKeys(db, clientLabelId, serverLabel.id);
                });
                // The rows behind this one are re-read when the pass reaches them.
              }
              idempotentConflict = true;
            }
          }
        }
        if (!idempotentConflict && acceptsServerStateOnRejection(entry.operation, body)) {
          // Rejected, but not worth a failed change: drop it and pull the note,
          // so its local state becomes the server's again (#1285).
          console.info(
            `Dropping queued operation id=${entry.id} ${entry.operation} ${endpoint} (HTTP ${status}): taking the server's state`,
          );
          // Nothing landed, so the snapshot gate has nothing to record.
          for (const noteId of writtenNoteIds) pullNoteIds.add(noteId);
        } else if (!idempotentConflict) {
          // The edit is lost server-side (the failed-changes banner surfaces it),
          // so this one is worth a warning.
          console.warn(`Discarding queued operation id=${entry.id} ${entry.operation} ${endpoint} (HTTP ${status})`);
          const noteIds = writtenNoteIds;
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
          for (const noteId of writtenNoteIds) {
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
          if (entry.operation !== 'markViewed') recordWriteLanded(writtenNoteIds);
        }

        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      } else if (await isGlobalDrainFailureProbed(err)) {
        // No usable server response (a network error, or a timeout while the
        // server does not answer the probe) or a status that blocks the whole
        // queue regardless of this entry (401 re-auth, 408, 429 rate-limit, or
        // a 502/503/504 from a proxy whose server is down).
        // Every entry would fail the same way, so stop the pass without
        // charging this entry's attempt counter and retry the remainder on the
        // next pass (issue #714). Expected whenever the
        // server drops away, so info, and the message alone: the stack of a
        // network error is bundle offsets that say nothing.
        console.info(`Queue drain stopped at entry id=${entry.id} (connectivity): ${errorSummary(err)}`);
        stoppedOnConnectivity = true;
        break;
      } else {
        // Entry-specific transient failure: a 5xx tied to this op's payload (a
        // gateway status or a client timeout only when the server answered the
        // probe), or a non-HTTP error thrown while processing this entry.
        const now = Date.now();
        const { attempts, processingErrors, capped, nextAttemptAt: retryAt, firstFailedAt, spacedFailures } =
          await chargeEntryFailure(db, entry, err, now);
        const httpFailure = axios.isAxiosError(err);
        // A failed send counts toward stopping the pass; a local error sent nothing.
        if (httpFailure) consecutiveSendFailures += 1;

        if (attempts >= MAX_ENTRY_DRAIN_ATTEMPTS && BEST_EFFORT_OPERATIONS.has(entry.operation)) {
          // Best-effort (see the permanent-failure branch above): the next
          // server sync reconciles what it would have done, so drop it rather
          // than hold back its note's edits behind it.
          console.info(
            `Dropping queued operation id=${entry.id} ${entry.operation} ${endpoint} after ${attempts} failed attempts`,
          );
          await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
          continue;
        }

        // An HTTP failure that has gone on long enough: the server never
        // rejected the op, but it is not going to take it either (#1301).
        const givenUp = httpFailure
          && (options.upgrade === true
            ? attempts >= GIVE_UP_AFTER_ATTEMPTS
            : spacedFailures >= GIVE_UP_AFTER_ATTEMPTS && now - firstFailedAt >= GIVE_UP_AFTER_MS);

        if (!capped && !givenUp) {
          // Not rejected by the server: stays queued, waits, and holds back its
          // dependents (#1283, #1301).
          console.warn(
            `Queue entry id=${entry.id} ${entry.operation} failed (attempt ${attempts}); `
              + `holding back the ops that depend on it: ${errorSummary(err)}`,
          );
          for (const key of keys) blockedKeys.add(key);
          noteWait(retryAt);
          continue;
        }

        // A non-HTTP processing error at the cap is dead-lettered with
        // PROCESSING_ERROR_STATUS (0); an HTTP failure given up on keeps its
        // status (0 for a client timeout). Either way with the endpoint/body
        // actually sent.
        const deadStatus = httpFailure ? err.response?.status ?? PROCESSING_ERROR_STATUS : PROCESSING_ERROR_STATUS;
        const errorMessage = errorSummary(err);
        const why = capped
          ? `${processingErrors} processing errors`
          : `failing for ${Math.round((now - firstFailedAt) / 60000)} min over ${attempts} attempts`;
        discardedOperations.push({ operation: entry.operation, endpoint, status: deadStatus });
        // As for a rejection: the app shows settings the server never took,
        // so the caller re-reads them.
        if (entry.operation === 'updateSettings') syncedSettings = true;
        if (uploadNoteId !== undefined) {
          console.warn(`Flagging image upload id=${entry.id} as failed after ${why}: ${errorMessage}`);
          const upload = parseImageUploadBody(body);
          if (upload) await flagImageUploadFailed(db, entry, uploadNoteId, upload, errorMessage, { attempts, processingErrors });
          else await discardImageUpload(db, entry, null);
        } else {
          console.warn(`Dead-lettering queued operation id=${entry.id} after ${why}: ${errorMessage}`);
          const noteIds = writtenNoteIds;
          await recordDeadLetter(db, entry, endpoint, body, deadStatus, noteIds.length === 1 ? noteIds[0]! : null, {
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
  }
  const stoppedOnFailures = consecutiveSendFailures >= MAX_CONSECUTIVE_SEND_FAILURES;
  if (!options.upgrade) {
    if (stoppedOnFailures) resumeAfterByDb.set(db, lastVisitedId);
    else resumeAfterByDb.delete(db);
  }

  // Merges into the last row are open again. A pass that throws leaves its
  // row recorded until the next claim, which only means an append instead.
  sendingEntryByDb.delete(db);

  // Also while held: holdDrain waits for this pass, pulls included, so they
  // still run under a valid session, and a refused deletion must not leave
  // these notes stale.
  if (pullNoteIds.size > 0 && !stoppedOnConnectivity) {
    await pullTouchedNotes(db, pullNoteIds);
  }

  // Ids are AUTOINCREMENT, never reused: a row above the last one this pass
  // loaded was queued while it ran.
  const lastLoadedId = entryIds[entryIds.length - 1] ?? 0;
  const leftRow = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM sync_queue WHERE id <= ?',
    [lastLoadedId],
  );
  if (stoppedOnFailures) {
    console.info(`Queue drain stopped after ${MAX_CONSECUTIVE_SEND_FAILURES} failed sends in a row`);
  }
  return {
    syncedNotes,
    discardedOperations,
    syncedSettings,
    leftBehind: leftRow?.count ?? 0,
    stoppedOnConnectivity,
    stoppedOnFailures,
    nextAttemptAt,
  };
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
function isOwnVersion({ version }: Note, baseVersion: number): boolean {
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
    'SELECT 1 AS found FROM sync_queue_keys WHERE key = ? AND read_only = 0 AND entry_id IS NOT ? LIMIT 1',
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
 * last and mark the server unreachable. A note the server reports gone
 * (404/410) is tombstoned through {@link applyServerRemoval}. Best effort: any
 * other failed fetch leaves the note for the next background sync.
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
    const since = snapshotMark();
    try {
      const note = await jot.notes.getById(noteId);
      await saveServerNote(db, note, since);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 404 || status === 410) {
        // Gone on the server: a change the server rejected on it must not stay
        // behind as local state nothing protects. Same rule as useOfflineNote's
        // refresh: tombstoned unless it is protected or written since `since`.
        try {
          await applyServerRemoval(db, noteId, since, 'tombstone');
        } catch (removeErr) {
          console.warn(`Failed to tombstone note id=${noteId} after the queue drain: ${errorSummary(removeErr)}`);
        }
        continue;
      }
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
 * — the queue drain's replay, or a failed change's resolution re-reading the
 * note (spec §8.3, #1262).
 * Returns true when the note was saved in full.
 *
 * - **Unresolved failed change:** take neither content nor version; the local
 *   row is what "Keep my version" forks from.
 * - **Another op queued for the note:** the response predates that edit, so
 *   take no content. Take the version only with `ownVersion`, so a chain of
 *   queued edits replays against the versions its own writes produced (#489):
 *   it holds nothing but this device's write, which the row already has
 *   (spec §8.1). A version that may carry a collaborator's edit is never
 *   adopted without its content.
 * - **Otherwise:** save it whole, which also brings in any collaborator edit
 *   made while the note was protected from snapshots.
 *
 * The checks and the write share one transaction, so a write serialized
 * behind it cannot slip in between.
 */
export async function saveServerResponseNote(
  db: SQLiteDatabase,
  note: Note,
  options: ServerResponseOptions = {},
): Promise<boolean> {
  let saved = false;
  await withSerializedTransaction(db, async () => {
    saved = await saveServerResponseNoteInTx(db, note, options);
  });
  return saved;
}

/** {@link saveServerResponseNote} without its own transaction: the caller runs it inside one. */
async function saveServerResponseNoteInTx(
  db: SQLiteDatabase,
  note: Note,
  options: ServerResponseOptions,
): Promise<boolean> {
  if (await hasUnresolvedFailure(db, note.id, options.exceptDeadLetterId)) return false;
  if (await hasOtherQueuedOpForNote(db, note.id, options.exceptEntryId)) {
    if (options.ownVersion && typeof note.version === 'number') {
      await setLocalNoteVersion(db, note.id, note.version);
    }
    return false;
  }
  // Server snapshot semantics for the completed flags, but no
  // keepLocalCompletedIds: the check above only lets the save through when no
  // other op, a queued completed op included, is waiting for the note.
  await saveNoteInTx(db, note, true);
  return true;
}

/**
 * Reconciles a note's local rows against a drain response's full item list
 * (see reconcileLocalItemsInTx), inside the transaction that deletes its queue
 * entry `entryId`. Like {@link saveServerResponseNoteInTx}, it takes nothing
 * while another op is queued for the note or a failed change is unresolved:
 * the list predates those local edits (spec §8.3). `items` is `unknown` since
 * it's a raw response body; anything other than an array (e.g. a
 * malformed/legacy response) is skipped rather than wiping the note's items.
 */
async function reconcileItemsFromResponseInTx(db: SQLiteDatabase, noteId: string, items: unknown, entryId: number): Promise<void> {
  if (!Array.isArray(items)) return;
  if (await hasUnresolvedFailure(db, noteId, undefined)) return;
  if (await hasOtherQueuedOpForNote(db, noteId, entryId)) return;
  await reconcileLocalItemsInTx(db, noteId, items as NoteItem[]);
}

/**
 * Fetch a note's share state after a share/unshare replay. Both return 204 (no
 * body) yet leave the local note holding an optimistic `shared_with` (a
 * synthetic `optimistic_<userId>` row, or a row the unshare removed): the GET
 * gives the server-assigned share ids, which the landing transaction writes.
 * Only the share columns are written (not a full saveNote) so a content edit
 * still queued for the same note isn't clobbered. Best-effort: a failed fetch
 * resolves to null and leaves the optimistic state for the next background sync.
 */
async function fetchNoteShares(
  noteId: string | undefined,
): Promise<{ id: string; is_shared: boolean; shared_with: NoteShare[] } | null> {
  if (!noteId) return null;
  try {
    const data: unknown = await jot.notes.getById(noteId);
    if (!hasStringId(data)) return null;
    const note = data as Note;
    return { id: note.id, is_shared: note.is_shared, shared_with: note.shared_with ?? [] };
  } catch (err) {
    console.warn(`Failed to reconcile note id=${noteId} after share/unshare drain:`, err);
    return null;
  }
}

/** A version-guarded edit sent at `from` that the server accepted as `to`: this device's own version. */
interface OwnVersionStep {
  noteId: string;
  from: number;
  to: number;
}

/**
 * Rebase the content edits still queued for a note from `from` to `to`, after
 * this device's own edit sent at `from` landed as `to` (spec §8.2, #1284). Each
 * queued edit stores the version its editor showed; one that was based on the
 * same text as the landed edit would otherwise be sent against a version the
 * note has left, and conflict with the device's own write. An edit based on
 * any other version is left alone: if that version is stale, the 409 is real.
 * Runs in the landing transaction, so a restart cannot separate the two; the
 * rest of a running pass resolves the same step through ownVersions.ts.
 */
async function rebaseQueuedEdits(db: SQLiteDatabase, { noteId, from, to }: OwnVersionStep): Promise<void> {
  recordOwnVersionStep(db, noteId, from, to);
  if (from === to) return;
  await db.runAsync(
    `UPDATE sync_queue SET body = json_set(body, '$.base_version', ?)
     WHERE operation IN ('update', 'convertNoteType')
       AND json_extract(body, '$.base_version') = ?
       AND id IN (SELECT entry_id FROM sync_queue_keys WHERE key = ? AND read_only = 0)`,
    [to, from, noteKey(noteId)],
  );
}
