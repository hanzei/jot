import { SQLiteDatabase } from 'expo-sqlite';
import axios from 'axios';
import api from '../api/client';
import type { GetNotesParams, Note, NoteItem } from '@jot/shared';
import { replaceLocalNoteId, saveNote, saveNotes, patchLocalItem, removeLocalNotesNotIn } from './noteQueries';

export type QueueOperation =
  | 'create'
  | 'update'
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
  | 'updateSettings';

interface QueueEntry {
  id: number;
  operation: QueueOperation;
  endpoint: string;
  method: string;
  body: string | null;
  created_at: string;
}

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

function notifyEnqueueListeners(): void {
  for (const listener of enqueueListeners) {
    try {
      listener();
    } catch (err) {
      console.warn('Enqueue listener failed:', err);
    }
  }
}

export async function enqueueOperation(db: SQLiteDatabase, params: EnqueueParams): Promise<void> {
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
  notifyEnqueueListeners();
}

export async function getPendingCount(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM sync_queue');
  return row?.count ?? 0;
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
 * Collect the IDs of every note that currently has a pending operation in the
 * sync queue. Server-sourced read paths (background fetch, SSE) consult this set
 * so a fetch of stale server state can't transiently revert an optimistic local
 * edit before its queued op has drained (see issue #487).
 *
 * Note IDs are recovered from the endpoint shapes enqueued by useNotes/useLabels
 * (see the per-branch comments below). Label-only endpoints (/labels/…) aren't
 * tied to a single note and are skipped.
 */
export async function getPendingNoteIds(db: SQLiteDatabase): Promise<Set<string>> {
  const entries = await db.getAllAsync<Pick<QueueEntry, 'endpoint' | 'body'>>(
    'SELECT endpoint, body FROM sync_queue',
  );

  const ids = new Set<string>();
  for (const entry of entries) {
    // Drop any query string (e.g. "/notes/{id}?permanent=true") before splitting,
    // and filter out the empty segment from the leading slash.
    const segments = entry.endpoint.split('?')[0].split('/').filter(Boolean);
    if (segments[0] !== 'notes') continue;

    if (segments.length === 1) {
      // POST /notes (create): the affected note is the offline-created local id.
      const localId = parseQueueBody(entry.body)?.local_id;
      if (typeof localId === 'string') ids.add(localId);
    } else if (segments[1] === 'reorder') {
      // POST /notes/reorder: body.note_ids lists every note whose position moved.
      const noteIds = parseQueueBody(entry.body)?.note_ids;
      if (Array.isArray(noteIds)) {
        for (const id of noteIds) if (typeof id === 'string') ids.add(id);
      }
    } else {
      // Any /notes/{id}/... op touches that note.
      ids.add(segments[1]);
    }
  }
  return ids;
}

/**
 * Persist a note fetched from the server (background fetch, SSE, post-import sync),
 * leaving notes with a pending sync-queue op untouched (see {@link getPendingNoteIds}
 * for the rationale, #487). Once the queue drains the gate is empty, so the next
 * server fetch or SSE event re-applies canonical server state normally.
 */
export async function saveServerNote(db: SQLiteDatabase, note: Note): Promise<void> {
  await saveNote(db, note, { skipNoteIds: await getPendingNoteIds(db) });
}

/** Batch counterpart of {@link saveServerNote}; reads the pending set once. */
export async function saveServerNotes(db: SQLiteDatabase, notes: Note[]): Promise<void> {
  await saveNotes(db, notes, { skipNoteIds: await getPendingNoteIds(db) });
}

/**
 * Reconcile a scoped server note list into local SQLite: persist the fetched notes
 * and prune local rows that have fallen out of this scope. Both steps share a single
 * pending-op set so notes with an unsynced local edit are neither overwritten nor
 * pruned — a queued edit can optimistically move a note into the scope before the
 * server reflects it (e.g. un-archive/restore), and pruning it would lose the edit (#487).
 */
export async function saveServerNotesScope(
  db: SQLiteDatabase,
  serverNotes: Note[],
  params?: GetNotesParams,
): Promise<void> {
  const skipNoteIds = await getPendingNoteIds(db);
  await saveNotes(db, serverNotes, { skipNoteIds });
  const serverIds = new Set(serverNotes.map((n) => n.id));
  await removeLocalNotesNotIn(db, serverIds, params, { skipNoteIds });
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
  /** Permanent HTTP status code that caused the discard (a non-transient 4xx). */
  status: number;
}

export interface DrainResult {
  /** Maps local_* IDs to the server IDs assigned during create operations. */
  idMappings: Array<{ localId: string; serverNote: Note }>;
  /** Operations that were discarded because the server returned a permanent (non-transient 4xx) error. */
  discardedOperations: DiscardedOperation[];
  /** True if at least one `updateSettings` operation was successfully drained. */
  syncedSettings: boolean;
}

/**
 * Drain the sync queue in FIFO order. For each entry, make the corresponding API call.
 * On success, delete the entry. On a permanent client error (non-transient 4xx),
 * discard the entry and continue. On a transient failure (network/timeout/5xx), stop
 * draining and retry the remaining entries on the next reconnect.
 *
 * Handles offline-create ID reconciliation: when a `create` operation succeeds, the
 * server returns a new note ID. Any subsequent queue entries that reference the local
 * temporary ID are remapped to the server-assigned ID before execution.
 *
 * Returns an array of {localId, serverNote} pairs for any create operations that
 * succeeded, so callers can update their caches.
 */
export async function drainQueue(db: SQLiteDatabase): Promise<DrainResult> {
  const entries = await db.getAllAsync<QueueEntry>(
    'SELECT * FROM sync_queue ORDER BY id ASC',
  );

  // Maps local_* IDs → server IDs as creates are processed
  const idMap = new Map<string, string>();
  const idMappings: Array<{ localId: string; serverNote: Note }> = [];
  const discardedOperations: DiscardedOperation[] = [];
  let syncedSettings = false;

  for (const entry of entries) {
    try {
      let body: Record<string, unknown> | undefined;
      if (entry.body) {
        body = JSON.parse(entry.body) as Record<string, unknown>;
        body = remapIdsInBody(body, idMap);
      }

      // Remap local IDs in the endpoint path, matching only complete path segments
      // to avoid corrupting URLs where the ID appears as a substring.
      let endpoint = entry.endpoint;
      for (const [localId, serverId] of idMap) {
        endpoint = endpoint
          .split('/')
          .map((seg) => (seg === localId ? serverId : seg))
          .join('/');
      }

      if (entry.method === 'POST') {
        const response = await api.post(endpoint, body);

        if (entry.operation === 'create' && body?.local_id) {
          const localId = body.local_id as string;
          const data = response?.data;
          if (hasStringId(data) && data.id !== localId) {
            const serverNote = data as Note;
            idMap.set(localId, serverNote.id);
            idMappings.push({ localId, serverNote });
            // Replace local note in DB with server note
            await replaceLocalNoteId(db, localId, serverNote);
          }
        } else if (entry.operation === 'createLabel' && body?.local_id) {
          // Reconcile the offline-generated local label id with the server id so
          // later queued ops that reference it (rename/delete/remove-from-note)
          // are remapped. Labels are derived from notes' labels_json rather than a
          // dedicated table, so no row is rewritten here — the remap is enough.
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
            const noteId = endpoint.split('/')[2];
            for (const item of items) {
              await patchLocalItem(db, noteId, item.id, { completed: item.completed });
            }
          }
        }
      } else if (entry.method === 'PATCH') {
        await api.patch(endpoint, body);
        if (entry.operation === 'updateSettings') {
          syncedSettings = true;
        }
      } else if (entry.method === 'DELETE') {
        const response = await api.delete(endpoint);
        if (entry.operation === 'removeLabelFromNote') {
          // The server returns the updated note; persist it so the local
          // labels_json drops the removed label and stays consistent.
          await saveNoteFromResponse(db, response?.data);
        }
      }

      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;

      // `isTransientHttpStatus(undefined)` is true, so reaching this branch
      // guarantees `status` is a defined, non-transient HTTP code.
      if (status !== undefined && !isTransientHttpStatus(status)) {
        // Permanent client error (e.g. 400/403/404/409/422) — replaying will
        // never succeed, so discard (dead-letter) the entry and continue rather
        // than letting one bad operation wedge the whole queue indefinitely.
        console.warn(`Discarding queued operation id=${entry.id} (HTTP ${status})`);
        discardedOperations.push({ operation: entry.operation, endpoint: entry.endpoint, status });
        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      } else {
        // Transient failure (network/timeout/401/408/429/5xx) or an unexpected
        // non-HTTP error — stop draining and retry the rest on the next reconnect.
        console.warn(`Queue drain stopped at entry id=${entry.id}:`, err);
        break;
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
