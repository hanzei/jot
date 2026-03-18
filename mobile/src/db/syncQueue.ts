import { SQLiteDatabase } from 'expo-sqlite';
import axios from 'axios';
import api from '../api/client';
import type { Note } from '@jot/shared';
import { replaceLocalNoteId, saveNote } from './noteQueries';

export type QueueOperation = 'create' | 'update' | 'delete' | 'restore' | 'permanentDelete' | 'reorder';

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
  method: 'POST' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
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
  /** HTTP status code that caused the discard (404 or 409). */
  status: number;
}

export interface DrainResult {
  /** Maps local_* IDs to the server IDs assigned during create operations. */
  idMappings: Array<{ localId: string; serverNote: Note }>;
  /** Operations that were discarded because the server returned 404 or 409. */
  discardedOperations: DiscardedOperation[];
}

/**
 * Drain the sync queue in FIFO order. For each entry, make the corresponding API call.
 * On success, delete the entry. On 404/409, discard and warn. On network error, stop.
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
        }
      } else if (entry.method === 'PUT') {
        await api.put(endpoint, body);
      } else if (entry.method === 'DELETE') {
        await api.delete(endpoint);
      }

      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;

      if (status === 404 || status === 409) {
        // Note no longer exists on server — discard and continue
        console.warn(`Discarding queued operation id=${entry.id} (HTTP ${status})`);
        discardedOperations.push({ operation: entry.operation, endpoint: entry.endpoint, status });
        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      } else {
        // Network or server error — stop draining; retry on next reconnect
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
