import type { SQLiteDatabase } from 'expo-sqlite';
import type { Note } from '../types';

export const upsertNotes = async (db: SQLiteDatabase, notes: Note[]): Promise<void> => {
  await db.withTransactionAsync(async () => {
    for (const note of notes) {
      await db.runAsync(
        `INSERT OR REPLACE INTO notes
          (id, user_id, title, content, note_type, color, pinned, archived, position,
           checked_items_collapsed, is_shared, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          note.id, note.user_id, note.title, note.content, note.note_type, note.color,
          note.pinned ? 1 : 0, note.archived ? 1 : 0, note.position,
          note.checked_items_collapsed ? 1 : 0, note.is_shared ? 1 : 0,
          note.deleted_at ?? null, note.created_at, note.updated_at,
        ]
      );

      if (note.items) {
        await db.runAsync('DELETE FROM note_items WHERE note_id = ?', [note.id]);
        for (const item of note.items) {
          await db.runAsync(
            `INSERT INTO note_items (id, note_id, text, completed, position, indent_level, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [item.id, item.note_id, item.text, item.completed ? 1 : 0, item.position, item.indent_level, item.created_at, item.updated_at]
          );
        }
      }
    }
  });
};

export const getLocalNotes = async (
  db: SQLiteDatabase,
  options: { archived?: boolean; trashed?: boolean; search?: string } = {}
): Promise<Note[]> => {
  let query = `SELECT * FROM notes WHERE 1=1`;
  const params: (string | number | null)[] = [];

  if (options.trashed) {
    query += ` AND deleted_at IS NOT NULL`;
  } else {
    query += ` AND deleted_at IS NULL`;
    query += ` AND archived = ?`;
    params.push(options.archived ? 1 : 0);
  }

  if (options.search) {
    query += ` AND (title LIKE ? OR content LIKE ?)`;
    params.push(`%${options.search}%`, `%${options.search}%`);
  }

  query += ` ORDER BY pinned DESC, position ASC`;

  const rows = await db.getAllAsync<Record<string, unknown>>(query, params);

  return rows.map((row) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    title: row.title as string,
    content: row.content as string,
    note_type: row.note_type as 'text' | 'todo',
    color: row.color as string,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    position: row.position as number,
    checked_items_collapsed: row.checked_items_collapsed === 1,
    is_shared: row.is_shared === 1,
    labels: [],
    deleted_at: row.deleted_at as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }));
};

export const deleteLocalNote = async (db: SQLiteDatabase, noteId: string): Promise<void> => {
  await db.runAsync('DELETE FROM notes WHERE id = ?', [noteId]);
};
