/**
 * Row builders for suites that seed a real SQLite database (see `testDb.ts`).
 * Every field the schema requires has a default, so a test only spells out the
 * columns its assertion actually depends on.
 */
import type { Label, ListNote, NoteItem, TextNote } from '@jot/shared';
import type { EnqueueParams } from '../../src/db/syncQueue';
import type { PendingImageUploadEntry } from '../../src/db/imageUploadQueue';
import { insertKeys, legacyQueueKeys, loadLabelIdsByName } from '../../src/db/queueKeys';
import { saveNote } from '../../src/db/noteQueries';
import type { TestDatabase } from './testDb';

const baseNote: Omit<TextNote, 'id' | 'note_type' | 'content'> = {
  user_id: 'u1',
  version: 1,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  is_shared: false,
  unread: null,
  labels: [],
  shared_with: [],
  deleted_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

export function makeTextNote(overrides: Partial<TextNote> & { id: string }): TextNote {
  return { ...baseNote, note_type: 'text', content: '', ...overrides };
}

export function makeListNote(overrides: Partial<ListNote> & { id: string }): ListNote {
  return { ...baseNote, note_type: 'list', title: '', checked_items_collapsed: false, ...overrides };
}

export function makeLabel(overrides: Partial<Label> & { id: string; name: string }): Label {
  return { user_id: 'u1', created_at: '', updated_at: '', ...overrides };
}

export function makeNoteItem(overrides: Partial<NoteItem> & { id: string; note_id: string }): NoteItem {
  return {
    text: '',
    completed: false,
    position: 0,
    parent_id: null,
    assigned_to: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Append a sync-queue entry and return its generated id. `attempts` seeds the
 * transient-failure counter that migration 6 added, for tests that start an
 * entry partway to the dead-letter cap. Without `keys`, the keys are what the
 * migration 13 backfill derives from the endpoint and body.
 */
export async function seedQueueEntry(
  db: TestDatabase,
  params: Omit<EnqueueParams, 'keys'> & {
    keys?: EnqueueParams['keys'];
    attempts?: number;
    processing_errors?: number;
    created_at?: string;
  },
): Promise<number> {
  const result = await db.runAsync(
    `INSERT INTO sync_queue (operation, endpoint, method, body, created_at, attempts, processing_errors)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      params.operation,
      params.endpoint,
      params.method,
      params.body ? JSON.stringify(params.body) : null,
      params.created_at ?? '2026-01-01T00:00:00Z',
      params.attempts ?? 0,
      params.processing_errors ?? 0,
    ],
  );
  const keys = params.keys
    ? { keys: params.keys, readKeys: params.readKeys }
    : legacyQueueKeys(params.operation, params.endpoint, params.body ?? null, await loadLabelIdsByName(db));
  await insertKeys(db, 'sync_queue_keys', result.lastInsertRowId, keys);
  return result.lastInsertRowId;
}

/**
 * Insert a `pending_image_uploads` row (and the note it hangs off, for the FK),
 * with its stable file copy present in the mock filesystem.
 */
export async function seedImageUpload(
  db: TestDatabase,
  overrides: Partial<PendingImageUploadEntry> = {},
): Promise<PendingImageUploadEntry> {
  const id = overrides.id ?? 'upload-1';
  const entry: PendingImageUploadEntry = {
    id,
    note_id: 'note-1',
    local_path: `file:///docs/pending-image-uploads/${id}`,
    filename: 'photo.png',
    mime_type: 'image/png',
    size_bytes: 1024,
    status: 'queued',
    error_message: null,
    created_at: '2024-01-01T00:00:00Z',
    attempts: 0,
    ...overrides,
  };
  const exists = await db.getFirstAsync('SELECT id FROM notes WHERE id = ?', [entry.note_id]);
  if (!exists) {
    await saveNote(db, makeTextNote({ id: entry.note_id }));
  }
  await db.runAsync(
    `INSERT INTO pending_image_uploads
       (id, note_id, local_path, filename, mime_type, size_bytes, status, error_message, created_at, attempts, processing_errors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id, entry.note_id, entry.local_path, entry.filename, entry.mime_type,
      entry.size_bytes, entry.status, entry.error_message, entry.created_at, entry.attempts ?? 0,
      entry.processing_errors ?? 0,
    ],
  );
  globalThis.mockFileSystem.files.set(entry.local_path, 'png-bytes');
  return entry;
}

/** Ids still in the sync queue, oldest first. */
export async function remainingQueueIds(db: TestDatabase): Promise<number[]> {
  const rows = await db.getAllAsync<{ id: number }>('SELECT id FROM sync_queue ORDER BY id ASC');
  return rows.map((r) => r.id);
}

/** A queued op as a test asserts it: its row, parsed body, and the keys it writes and reads. */
export interface QueuedOp {
  operation: string;
  endpoint: string;
  method: string;
  body: Record<string, unknown> | null;
  keys: string[];
  readKeys: string[];
}

/** Every queued op, oldest first, with its `sync_queue_keys`. */
export async function queuedOps(db: TestDatabase): Promise<QueuedOp[]> {
  const rows = await db.getAllAsync<{ id: number; operation: string; endpoint: string; method: string; body: string | null }>(
    'SELECT id, operation, endpoint, method, body FROM sync_queue ORDER BY id ASC',
  );
  const ops: QueuedOp[] = [];
  for (const row of rows) {
    const keys = await db.getAllAsync<{ key: string; read_only: number }>(
      'SELECT key, read_only FROM sync_queue_keys WHERE entry_id = ? ORDER BY rowid',
      [row.id],
    );
    ops.push({
      operation: row.operation,
      endpoint: row.endpoint,
      method: row.method,
      body: row.body ? JSON.parse(row.body) as Record<string, unknown> : null,
      keys: keys.filter((k) => !k.read_only).map((k) => k.key),
      readKeys: keys.filter((k) => k.read_only).map((k) => k.key),
    });
  }
  return ops;
}
