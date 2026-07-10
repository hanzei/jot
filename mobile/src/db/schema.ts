import { SQLiteDatabase } from 'expo-sqlite';

// Migration 1: creates initial schema; idempotent via IF NOT EXISTS and column probing.
const migration1 = async (db: SQLiteDatabase): Promise<void> => {
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
      version INTEGER NOT NULL DEFAULT 1,
      is_shared INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      shared_with_json TEXT NOT NULL DEFAULT '[]',
      images_json TEXT NOT NULL DEFAULT '[]',
      sync_state TEXT NOT NULL DEFAULT 'synced'
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

    -- Dead-lettered sync operations: writes the server permanently rejected
    -- (non-transient 4xx, excluding idempotent 409s). Preserved with their full
    -- body + metadata so a failed optimistic edit is never silently dropped and
    -- can later be surfaced/resolved (issue #492). note_id links the row to the
    -- affected note (NULL for ops not tied to a single note, e.g. settings).
    CREATE TABLE IF NOT EXISTS dead_letter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      body TEXT,
      status INTEGER NOT NULL,
      note_id TEXT,
      created_at TEXT NOT NULL,
      failed_at TEXT NOT NULL
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

  // Handle pre-versioned installs that may be missing newer columns.
  const noteCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(notes)');
  if (!noteCols.some((c) => c.name === 'sync_state')) {
    await db.runAsync(`ALTER TABLE notes ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'synced'`);
  }

  const noteItemCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(note_items)');
  const noteItemColNames = new Set(noteItemCols.map((c) => c.name));
  for (const col of ['created_at', 'updated_at', 'assigned_to']) {
    if (!noteItemColNames.has(col)) {
      await db.runAsync(`ALTER TABLE note_items ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }
  if (!noteItemColNames.has('parent_id')) {
    await db.runAsync(`ALTER TABLE note_items ADD COLUMN parent_id TEXT DEFAULT NULL`);
    if (noteItemColNames.has('indent_level')) {
      const rows = await db.getAllAsync<{ id: string; note_id: string; indent_level: number }>(
        `SELECT id, note_id, indent_level FROM note_items ORDER BY note_id, position`,
      );
      // Only one level of nesting was supported in the indent_level schema;
      // all indented rows (indent_level > 0) map to the nearest preceding top-level item.
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
};

// Migration 2: add an optimistic-concurrency version column to notes (issue #489).
// Mirrors the server's notes.version: it lets a queued offline update carry the
// version its edit was based on so a stale write is detected instead of silently
// clobbering a concurrent change. Column-probed so it is safe on installs that
// already created the table.
const migration2 = async (db: SQLiteDatabase): Promise<void> => {
  // Fresh installs already get the column from migration1's CREATE TABLE; this
  // ALTER is only for installs created before the column existed.
  const noteCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(notes)');
  if (!noteCols.some((c) => c.name === 'version')) {
    await db.runAsync(`ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
  }
};

// Migration 3: add an images_json column to notes, mirroring labels_json/
// shared_with_json, so a note's embedded image metadata (issue #616) can be
// cached locally alongside the rest of the note. Column-probed like migration2.
const migration3 = async (db: SQLiteDatabase): Promise<void> => {
  const noteCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(notes)');
  if (!noteCols.some((c) => c.name === 'images_json')) {
    await db.runAsync(`ALTER TABLE notes ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'`);
  }
};

// Migration 4: add a table for images picked while offline (or whose upload
// hit a transient failure), so they survive an app restart until the sync
// engine can flush them (issue #618). Bytes are copied to a stable app-owned
// path (outside any OS-managed cache dir) at enqueue time — see
// db/imageUploadQueue.ts — so `local_path` always points at a durable file.
const migration4 = async (db: SQLiteDatabase): Promise<void> => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS pending_image_uploads (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      local_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pending_image_uploads_note_id
      ON pending_image_uploads (note_id);
  `);
};

// Migration 5: give labels a real local store (issue #691). Until now the label
// list was derived entirely from notes' labels_json, so a label with zero
// attached notes had no local source: empty labels created on another device
// never appeared, and locally-created empty labels were wiped by any refetch of
// the notes-derived list. Add a canonical `labels` table (counts stay derived
// from notes) and backfill it from existing notes so no labels are lost on
// upgrade — additive, per the project's "preserve existing installations" rule.
const migration5 = async (db: SQLiteDatabase): Promise<void> => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);

  // Backfill from existing notes' labels_json so labels already in use survive
  // the upgrade. INSERT OR IGNORE keeps the first occurrence of each id and makes
  // the backfill idempotent.
  const rows = await db.getAllAsync<{ labels_json: string }>('SELECT labels_json FROM notes');
  const seen = new Set<string>();
  for (const row of rows) {
    let labels: { id: string; user_id?: string; name: string; created_at?: string; updated_at?: string }[] = [];
    try {
      labels = JSON.parse(row.labels_json);
    } catch {
      continue;
    }
    for (const label of labels) {
      if (!label?.id || seen.has(label.id)) {
        continue;
      }
      seen.add(label.id);
      await db.runAsync(
        `INSERT OR IGNORE INTO labels (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [label.id, label.user_id ?? '', label.name, label.created_at ?? '', label.updated_at ?? ''],
      );
    }
  }
};

export const MIGRATIONS: readonly ((db: SQLiteDatabase) => Promise<void>)[] = [migration1, migration2, migration3, migration4, migration5];

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  // Run PRAGMAs separately: sqlite3_exec (used by execAsync) stops on the
  // first error, so mixing PRAGMAs with DDL means a PRAGMA failure would
  // silently prevent the tables from being created.
  await db.runAsync('PRAGMA journal_mode = WAL');
  await db.runAsync('PRAGMA foreign_keys = ON');

  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    await MIGRATIONS[i](db);
    await db.runAsync(`PRAGMA user_version = ${i + 1}`);
  }
}
