/**
 * Row builders for suites that seed a real SQLite database (see `testDb.ts`).
 * Every field the schema requires has a default, so a test only spells out the
 * columns its assertion actually depends on.
 */
import type { Label, ListNote, NoteItem, TextNote } from '@jot/shared';
import type { EnqueueParams } from '../../src/db/syncQueue';
import type { PendingImageUploadEntry } from '../../src/db/imageUploadQueue';
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
 * entry partway to the dead-letter cap.
 */
export async function seedQueueEntry(
  db: TestDatabase,
  params: EnqueueParams & { attempts?: number; created_at?: string },
): Promise<number> {
  const result = await db.runAsync(
    `INSERT INTO sync_queue (operation, endpoint, method, body, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.operation,
      params.endpoint,
      params.method,
      params.body ? JSON.stringify(params.body) : null,
      params.created_at ?? '2026-01-01T00:00:00Z',
      params.attempts ?? 0,
    ],
  );
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
       (id, note_id, local_path, filename, mime_type, size_bytes, status, error_message, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id, entry.note_id, entry.local_path, entry.filename, entry.mime_type,
      entry.size_bytes, entry.status, entry.error_message, entry.created_at, entry.attempts ?? 0,
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
