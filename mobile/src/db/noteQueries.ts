import { SQLiteDatabase } from 'expo-sqlite';
import { Note, NoteItem, GetNotesParams, Label, NoteShare } from '../types';

interface NoteRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  note_type: string;
  color: string;
  pinned: number;
  archived: number;
  position: number;
  checked_items_collapsed: number;
  is_shared: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  labels_json: string;
  shared_with_json: string;
}

interface NoteItemRow {
  id: string;
  note_id: string;
  text: string;
  completed: number;
  position: number;
  indent_level: number;
}

function rowToNote(row: NoteRow, items: NoteItem[] = []): Note {
  let labels: Label[] = [];
  let shared_with: NoteShare[] = [];
  try { labels = JSON.parse(row.labels_json) as Label[]; } catch { /* ignore */ }
  try { shared_with = JSON.parse(row.shared_with_json) as NoteShare[]; } catch { /* ignore */ }
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    content: row.content,
    note_type: row.note_type as 'text' | 'todo',
    color: row.color,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    position: row.position,
    checked_items_collapsed: row.checked_items_collapsed === 1,
    is_shared: row.is_shared === 1,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    labels,
    shared_with,
    items,
  };
}

function itemRowToNoteItem(row: NoteItemRow): NoteItem {
  return {
    id: row.id,
    note_id: row.note_id,
    text: row.text,
    completed: row.completed === 1,
    position: row.position,
    indent_level: row.indent_level,
    created_at: '',
    updated_at: '',
  };
}

async function getItemsForNote(db: SQLiteDatabase, noteId: string): Promise<NoteItem[]> {
  const rows = await db.getAllAsync<NoteItemRow>(
    'SELECT * FROM note_items WHERE note_id = ? ORDER BY position ASC',
    [noteId],
  );
  return rows.map(itemRowToNoteItem);
}

// Writes a single note (and its items if provided) without wrapping in a transaction.
// Must only be called from within an existing transaction context.
async function saveNoteInTx(db: SQLiteDatabase, note: Note): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO notes
       (id, user_id, title, content, note_type, color, pinned, archived, position,
        checked_items_collapsed, is_shared, deleted_at, created_at, updated_at,
        labels_json, shared_with_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      note.id,
      note.user_id,
      note.title,
      note.content,
      note.note_type,
      note.color,
      note.pinned ? 1 : 0,
      note.archived ? 1 : 0,
      note.position,
      note.checked_items_collapsed ? 1 : 0,
      note.is_shared ? 1 : 0,
      note.deleted_at ?? null,
      note.created_at,
      note.updated_at,
      JSON.stringify(note.labels ?? []),
      JSON.stringify(note.shared_with ?? []),
    ],
  );

  if (note.items !== undefined) {
    await db.runAsync('DELETE FROM note_items WHERE note_id = ?', [note.id]);
    for (const item of note.items) {
      await db.runAsync(
        `INSERT OR REPLACE INTO note_items (id, note_id, text, completed, position, indent_level)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [item.id, note.id, item.text, item.completed ? 1 : 0, item.position, item.indent_level],
      );
    }
  }
}

export async function saveNote(db: SQLiteDatabase, note: Note): Promise<void> {
  await db.withTransactionAsync(() => saveNoteInTx(db, note));
}

export async function saveNotes(db: SQLiteDatabase, notes: Note[]): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const note of notes) {
      await saveNoteInTx(db, note);
    }
  });
}

export async function getLocalNotes(db: SQLiteDatabase, params?: GetNotesParams): Promise<Note[]> {
  let sql = 'SELECT * FROM notes WHERE 1=1';
  const args: (string | number | null)[] = [];

  if (params?.archived) {
    sql += ' AND archived = 1 AND deleted_at IS NULL';
  } else if (params?.trashed) {
    sql += ' AND deleted_at IS NOT NULL';
  } else {
    sql += ' AND archived = 0 AND deleted_at IS NULL';
  }

  if (params?.search) {
    sql += ' AND (title LIKE ? OR content LIKE ?)';
    args.push(`%${params.search}%`, `%${params.search}%`);
  }

  sql += ' ORDER BY pinned DESC, position ASC';
  const rows = await db.getAllAsync<NoteRow>(sql, args);

  if (rows.length === 0) return [];

  // Batch-fetch all note_items for todo notes in a single query (avoids N+1)
  const todoIds = rows.filter((r) => r.note_type === 'todo').map((r) => r.id);
  const itemsByNoteId = new Map<string, NoteItem[]>();
  if (todoIds.length > 0) {
    const placeholders = todoIds.map(() => '?').join(', ');
    const itemRows = await db.getAllAsync<NoteItemRow>(
      `SELECT * FROM note_items WHERE note_id IN (${placeholders}) ORDER BY position ASC`,
      todoIds,
    );
    for (const itemRow of itemRows) {
      const existing = itemsByNoteId.get(itemRow.note_id) ?? [];
      existing.push(itemRowToNoteItem(itemRow));
      itemsByNoteId.set(itemRow.note_id, existing);
    }
  }

  // Convert rows to Notes (rowToNote parses labels_json), then apply label filter
  const notes = rows.map((row) => rowToNote(row, itemsByNoteId.get(row.id) ?? []));
  if (params?.label) {
    return notes.filter((n) => n.labels.some((l) => l.id === params.label));
  }
  return notes;
}

export async function getLocalNote(db: SQLiteDatabase, id: string): Promise<Note | null> {
  const row = await db.getFirstAsync<NoteRow>('SELECT * FROM notes WHERE id = ?', [id]);
  if (!row) return null;
  const items = row.note_type === 'todo' ? await getItemsForNote(db, id) : [];
  return rowToNote(row, items);
}

export async function markLocalNoteDeleted(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(
    'UPDATE notes SET deleted_at = ? WHERE id = ?',
    [new Date().toISOString(), id],
  );
}

export async function markLocalNoteRestored(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(
    'UPDATE notes SET deleted_at = NULL, archived = 0 WHERE id = ?',
    [id],
  );
}

export async function permanentDeleteLocalNote(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM notes WHERE id = ?', [id]);
}

export async function updateLocalNote(
  db: SQLiteDatabase,
  id: string,
  changes: Partial<Pick<Note, 'title' | 'content' | 'pinned' | 'archived' | 'color' | 'checked_items_collapsed' | 'position'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (changes.title !== undefined) { fields.push('title = ?'); values.push(changes.title); }
  if (changes.content !== undefined) { fields.push('content = ?'); values.push(changes.content); }
  if (changes.pinned !== undefined) { fields.push('pinned = ?'); values.push(changes.pinned ? 1 : 0); }
  if (changes.archived !== undefined) { fields.push('archived = ?'); values.push(changes.archived ? 1 : 0); }
  if (changes.color !== undefined) { fields.push('color = ?'); values.push(changes.color); }
  if (changes.position !== undefined) { fields.push('position = ?'); values.push(changes.position); }
  if (changes.checked_items_collapsed !== undefined) {
    fields.push('checked_items_collapsed = ?');
    values.push(changes.checked_items_collapsed ? 1 : 0);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  await db.runAsync(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`, values);
}

export async function replaceLocalNoteId(
  db: SQLiteDatabase,
  oldId: string,
  newNote: Note,
): Promise<void> {
  await db.runAsync('DELETE FROM notes WHERE id = ?', [oldId]);
  await saveNote(db, newNote);
}

/** Generate a unique local ID for offline-created notes (prefixed so they are identifiable). */
export function generateLocalId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 9);
  return `local_${timestamp}_${random}`;
}

export function isLocalId(id: string): boolean {
  return id.startsWith('local_');
}
