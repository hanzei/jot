/**
 * Row builders for suites that seed a real SQLite database (see `testDb.ts`).
 * Every field the schema requires has a default, so a test only spells out the
 * columns its assertion actually depends on.
 */
import type { ListNote, NoteItem, TextNote } from '@jot/shared';
import type { EnqueueParams } from '../../src/db/syncQueue';
import type { TestDatabase } from './testDb';

const baseNote: Omit<TextNote, 'id' | 'note_type' | 'content'> = {
  user_id: 'u1',
  version: 1,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  is_shared: false,
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

/** Ids still in the sync queue, oldest first. */
export async function remainingQueueIds(db: TestDatabase): Promise<number[]> {
  const rows = await db.getAllAsync<{ id: number }>('SELECT id FROM sync_queue ORDER BY id ASC');
  return rows.map((r) => r.id);
}
