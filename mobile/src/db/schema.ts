import { SQLiteDatabase } from 'expo-sqlite';

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  // Run PRAGMAs separately: sqlite3_exec (used by execAsync) stops on the
  // first error, so mixing PRAGMAs with DDL means a PRAGMA failure would
  // silently prevent the tables from being created.
  await db.runAsync('PRAGMA journal_mode = WAL');
  await db.runAsync('PRAGMA foreign_keys = ON');

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      note_type TEXT NOT NULL DEFAULT 'text',
      color TEXT NOT NULL DEFAULT '#ffffff',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      checked_items_collapsed INTEGER NOT NULL DEFAULT 0,
      is_shared INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      shared_with_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS note_items (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT DEFAULT NULL,
      assigned_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notes_list
      ON notes (archived, deleted_at, pinned DESC, position ASC);

    CREATE INDEX IF NOT EXISTS idx_note_items_note_id
      ON note_items (note_id);

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      body TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      has_profile_icon INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);

  // Rename legacy note_type 'todo' → 'list' to match server migration 003.
  await db.runAsync(`UPDATE notes SET note_type = 'list' WHERE note_type = 'todo'`);

  // Migrate existing databases that pre-date newer columns.
  // Check which columns exist via PRAGMA, then ALTER TABLE only for missing ones.
  const noteItemCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(note_items)');
  const noteItemColNames = new Set(noteItemCols.map((c) => c.name));
  for (const col of ['created_at', 'updated_at', 'assigned_to']) {
    if (!noteItemColNames.has(col)) {
      await db.runAsync(`ALTER TABLE note_items ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }
  if (!noteItemColNames.has('parent_id')) {
    await db.runAsync(`ALTER TABLE note_items ADD COLUMN parent_id TEXT DEFAULT NULL`);
    // Backfill parent_id from indent_level for databases that used the old column.
    if (noteItemColNames.has('indent_level')) {
      const rows = await db.getAllAsync<{ id: string; note_id: string; indent_level: number }>(
        `SELECT id, note_id, indent_level FROM note_items ORDER BY note_id, position`,
      );
      let lastNoteId: string | null = null;
      let lastTopLevelId: string | null = null;
      for (const row of rows) {
        if (row.note_id !== lastNoteId) {
          lastNoteId = row.note_id;
          lastTopLevelId = null;
        }
        if (row.indent_level === 0) {
          lastTopLevelId = row.id;
        } else if (lastTopLevelId !== null) {
          await db.runAsync(`UPDATE note_items SET parent_id = ? WHERE id = ?`, [lastTopLevelId, row.id]);
        }
      }
    }
  }

}
