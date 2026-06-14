import { SQLiteDatabase } from 'expo-sqlite';
import axios from 'axios';
import api from '../api/client';
import type { Note } from '@jot/shared';
import { replaceLocalNoteId, saveNote, patchLocalItem } from './noteQueries';
import type { NoteItem } from '@jot/shared';

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
  | 'removeLabelFromNote';

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
 * Called from the `catch` of an online write attempt. If the failure is
 * transient (a flaky connection, timeout, or 5xx), it is swallowed so the
 * caller can fall back to the offline path — writing locally and queueing the
 * operation for replay — instead of losing the edit. Permanent failures (4xx
 * validation/auth/conflict) and unexpected local errors are rethrown so the UI
 * can surface them to the user.
 *
 * 401 is deliberately treated as non-queueable here even though the queue drain
 * retries it: the API response interceptor reacts to a 401 by clearing the
 * session and redirecting to login, so the write must surface the error rather
 * than silently report success while the user is being logged out.
 */
export function rethrowIfNotQueueable(err: unknown): void {
  if (!axios.isAxiosError(err)) {
    throw err;
  }
  const status = err.response?.status;
  if (status === 401 || !isTransientHttpStatus(status)) {
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

  return { idMappings, discardedOperations };
}

/** Persist a note returned by the server during queue drain, if the response looks like a note. */
async function saveNoteFromResponse(db: SQLiteDatabase, data: unknown): Promise<void> {
  if (hasStringId(data)) {
    await saveNote(db, data as Note);
  }
}
