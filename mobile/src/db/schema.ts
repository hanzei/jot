import { SQLiteDatabase } from 'expo-sqlite';

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
      indent_level INTEGER NOT NULL DEFAULT 0,
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
  `);
}
