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
  | 'unshare';

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
          if (
            data !== null &&
            typeof data === 'object' &&
            typeof (data as Note).id === 'string' &&
            (data as Note).id !== localId
          ) {
            const serverNote = data as Note;
            idMap.set(localId, serverNote.id);
            idMappings.push({ localId, serverNote });
            // Replace local note in DB with server note
            await replaceLocalNoteId(db, localId, serverNote);
          }
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
        await api.delete(endpoint);
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

/** Persist a note that was returned by the server after a successful sync, updating local DB. */
export async function updateLocalFromServer(db: SQLiteDatabase, note: Note): Promise<void> {
  await saveNote(db, note);
}
