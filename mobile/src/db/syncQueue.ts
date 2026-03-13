import { SQLiteDatabase } from 'expo-sqlite';
import api from '../api/client';
import { Note } from '../types';
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

function remapIdsInBody(
  body: Record<string, unknown>,
  idMap: Map<string, string>,
): Record<string, unknown> {
  if (idMap.size === 0) return body;
  let serialized = JSON.stringify(body);
  for (const [localId, serverId] of idMap) {
    serialized = serialized.split(localId).join(serverId);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

/**
 * Drain the sync queue in FIFO order. For each entry, make the corresponding API call.
 * On success, delete the entry. On 404/409, discard and warn. On network error, stop.
 *
 * Handles offline-create ID reconciliation: when a `create` operation succeeds, the
 * server returns a new note ID. Any subsequent queue entries that reference the local
 * temporary ID are remapped to the server-assigned ID before execution.
 */
export async function drainQueue(db: SQLiteDatabase): Promise<void> {
  const entries = await db.getAllAsync<QueueEntry>(
    'SELECT * FROM sync_queue ORDER BY id ASC',
  );

  // Maps local_* IDs → server IDs as creates are processed
  const idMap = new Map<string, string>();

  for (const entry of entries) {
    try {
      let body: Record<string, unknown> | undefined;
      if (entry.body) {
        body = JSON.parse(entry.body) as Record<string, unknown>;
        body = remapIdsInBody(body, idMap);
      }

      // Remap local IDs in the endpoint path
      let endpoint = entry.endpoint;
      for (const [localId, serverId] of idMap) {
        endpoint = endpoint.split(localId).join(serverId);
      }

      if (entry.method === 'POST') {
        const response = await api.post(endpoint, body);

        if (entry.operation === 'create' && body?.local_id) {
          const localId = body.local_id as string;
          const serverNote = response.data as Note;
          if (serverNote?.id && serverNote.id !== localId) {
            idMap.set(localId, serverNote.id);
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
      const status = (err as { response?: { status?: number } })?.response?.status;

      if (status === 404 || status === 409) {
        // Note no longer exists on server — discard and continue
        console.warn(`Discarding queued operation id=${entry.id} (HTTP ${status ?? 'unknown'})`);
        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [entry.id]);
      } else {
        // Network or server error — stop draining; retry on next reconnect
        console.warn(`Queue drain stopped at entry id=${entry.id}:`, err);
        break;
      }
    }
  }
}

/** Persist a note that was returned by the server after a successful sync, updating local DB. */
export async function updateLocalFromServer(db: SQLiteDatabase, note: Note): Promise<void> {
  await saveNote(db, note);
}
