import { migrateDatabase, MIGRATIONS } from '../src/db/schema';
import { createTestDb, type TestDatabase } from './helpers/testDb';

/**
 * These run against a real SQLite engine (see `helpers/testDb.ts`), so a
 * migration that references a missing column, adds a column twice, or leaves
 * the schema in a state the queries can't use fails here rather than passing
 * against a mock. The end state is what's asserted — not the SQL text.
 */

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

/** Every table and its columns, in a form that's stable across CREATE-vs-ALTER ordering. */
async function schemaSnapshot(db: TestDatabase): Promise<Record<string, string[]>> {
  const tables = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const snapshot: Record<string, string[]> = {};
  for (const table of tables) {
    const columns = await db.getAllAsync<ColumnInfo>(`PRAGMA table_info(${table.name})`);
    snapshot[table.name] = columns
      .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? 'NULL'} pk=${c.pk}`)
      .sort();
  }
  return snapshot;
}

async function columnNames(db: TestDatabase, table: string): Promise<string[]> {
  const columns = await db.getAllAsync<ColumnInfo>(`PRAGMA table_info(${table})`);
  return columns.map((c) => c.name);
}

async function userVersion(db: TestDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

async function indexNames(db: TestDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
  );
  return rows.map((r) => r.name);
}

async function freshlyMigratedDb(): Promise<TestDatabase> {
  const db = createTestDb();
  await migrateDatabase(db);
  return db;
}

/**
 * The schema as it stood before `user_version` tracking existed: no
 * `notes.sync_state` / `version` / `images_json`, `note_items` still keyed on
 * `indent_level` rather than `parent_id`, and no `attempts` counters. This is
 * the shape migration1's column probes and migration6's ALTERs exist for.
 */
async function preVersionedInstall(): Promise<TestDatabase> {
  const db = createTestDb();
  await db.execAsync(`
    CREATE TABLE notes (
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

    CREATE TABLE note_items (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      indent_level INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      body TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE dead_letter (
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

    CREATE TABLE users (
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
  return db;
}

async function insertLegacyNote(
  db: TestDatabase,
  note: { id: string; note_type?: string; labels_json?: string },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO notes (id, user_id, title, note_type, created_at, updated_at, labels_json)
     VALUES (?, 'u1', 'Note', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
    [note.id, note.note_type ?? 'text', note.labels_json ?? '[]'],
  );
}

describe('migrateDatabase', () => {
  describe('fresh install', () => {
    it('creates the full schema and records the latest user_version', async () => {
      const db = await freshlyMigratedDb();

      expect(await userVersion(db)).toBe(MIGRATIONS.length);
      expect(Object.keys(await schemaSnapshot(db)).sort()).toEqual([
        'dead_letter',
        'labels',
        'note_items',
        'notes',
        'pending_image_uploads',
        'sync_queue',
        'users',
      ]);
      expect(await indexNames(db)).toEqual([
        'idx_note_items_note_id',
        'idx_notes_list',
        'idx_pending_image_uploads_note_id',
      ]);
    });

    it('produces the columns the queries rely on', async () => {
      const db = await freshlyMigratedDb();

      expect(await columnNames(db, 'notes')).toEqual(
        expect.arrayContaining(['version', 'images_json', 'sync_state', 'labels_json', 'shared_with_json']),
      );
      expect(await columnNames(db, 'note_items')).toEqual(
        expect.arrayContaining(['parent_id', 'assigned_to', 'created_at', 'updated_at']),
      );
      expect(await columnNames(db, 'sync_queue')).toContain('attempts');
      expect(await columnNames(db, 'pending_image_uploads')).toContain('attempts');
      expect(await columnNames(db, 'dead_letter')).toEqual(expect.arrayContaining(['attempts', 'error_message']));
    });

    it('issues no ALTER TABLE — every column comes from the CREATE statements', async () => {
      const db = createTestDb();
      await migrateDatabase(db);

      const statements = db.runAsync.mock.calls.map((call) => String(call[0]));
      expect(statements.filter((s) => s.startsWith('ALTER TABLE'))).toEqual([]);
    });

    it('is idempotent — re-running over a current database changes nothing', async () => {
      const db = await freshlyMigratedDb();
      const before = await schemaSnapshot(db);

      await migrateDatabase(db);

      expect(await schemaSnapshot(db)).toEqual(before);
      expect(await userVersion(db)).toBe(MIGRATIONS.length);
    });

    it('skips every step when already at the latest version', async () => {
      const db = await freshlyMigratedDb();
      db.execAsync.mockClear();

      await migrateDatabase(db);

      expect(db.execAsync).not.toHaveBeenCalled();
    });
  });

  describe('stepwise application', () => {
    // Each migration has to apply cleanly to the schema the previous one left
    // behind. Resuming from every intermediate user_version proves that, and
    // that all paths converge on one schema.
    it.each(MIGRATIONS.map((_, index) => index))(
      'reaches the same schema when resumed from user_version %i',
      async (startVersion) => {
        const db = createTestDb();
        for (let i = 0; i < startVersion; i++) {
          await MIGRATIONS[i](db);
          await db.runAsync(`PRAGMA user_version = ${i + 1}`);
        }
        expect(await userVersion(db)).toBe(startVersion);

        await migrateDatabase(db);

        expect(await userVersion(db)).toBe(MIGRATIONS.length);
        expect(await schemaSnapshot(db)).toEqual(await schemaSnapshot(await freshlyMigratedDb()));
      },
    );

    it('preserves rows written before the remaining migrations run', async () => {
      const db = createTestDb();
      await MIGRATIONS[0](db);
      await db.runAsync('PRAGMA user_version = 1');
      await insertLegacyNote(db, { id: 'n1' });
      await db.runAsync(
        `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
         VALUES ('update_note', '/notes/n1', 'PATCH', '{}', '2026-01-01T00:00:00Z')`,
      );

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT id FROM notes')).toEqual([{ id: 'n1' }]);
      const queued = await db.getAllAsync<{ endpoint: string; attempts: number }>(
        'SELECT endpoint, attempts FROM sync_queue',
      );
      // The column migration6 adds takes its default on existing rows.
      expect(queued).toEqual([{ endpoint: '/notes/n1', attempts: 0 }]);
    });
  });

  describe('pre-versioned install', () => {
    it('converges on the fresh-install schema', async () => {
      const db = await preVersionedInstall();

      await migrateDatabase(db);

      expect(await userVersion(db)).toBe(MIGRATIONS.length);
      const fresh = await schemaSnapshot(await freshlyMigratedDb());
      const upgraded = await schemaSnapshot(db);
      for (const table of Object.keys(fresh)) {
        // note_items keeps its now-unused indent_level column; everything the
        // current schema defines has to be present with the same definition.
        expect(upgraded[table]).toEqual(expect.arrayContaining(fresh[table]));
      }
    });

    it('adds the columns missing from notes', async () => {
      const db = await preVersionedInstall();

      await migrateDatabase(db);

      expect(await columnNames(db, 'notes')).toEqual(
        expect.arrayContaining(['sync_state', 'version', 'images_json']),
      );
    });

    it('backfills the added notes columns with their defaults on existing rows', async () => {
      const db = await preVersionedInstall();
      await insertLegacyNote(db, { id: 'n1' });

      await migrateDatabase(db);

      expect(
        await db.getFirstAsync('SELECT sync_state, version, images_json FROM notes WHERE id = ?', ['n1']),
      ).toEqual({ sync_state: 'synced', version: 1, images_json: '[]' });
    });

    it('adds the columns missing from note_items', async () => {
      const db = await preVersionedInstall();

      await migrateDatabase(db);

      expect(await columnNames(db, 'note_items')).toEqual(
        expect.arrayContaining(['created_at', 'updated_at', 'assigned_to', 'parent_id']),
      );
    });

    it("renames the legacy 'todo' note type to 'list'", async () => {
      const db = await preVersionedInstall();
      await insertLegacyNote(db, { id: 'n1', note_type: 'todo' });
      await insertLegacyNote(db, { id: 'n2', note_type: 'text' });

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT id, note_type FROM notes ORDER BY id')).toEqual([
        { id: 'n1', note_type: 'list' },
        { id: 'n2', note_type: 'text' },
      ]);
    });

    it('adds the queue attempt counters and keeps queued rows', async () => {
      const db = await preVersionedInstall();
      await db.runAsync(
        `INSERT INTO dead_letter (operation, endpoint, method, body, status, note_id, created_at, failed_at)
         VALUES ('update_note', '/notes/n1', 'PATCH', '{}', 400, 'n1', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
      );

      await migrateDatabase(db);

      expect(
        await db.getFirstAsync('SELECT endpoint, status, attempts, error_message FROM dead_letter'),
      ).toEqual({ endpoint: '/notes/n1', status: 400, attempts: 0, error_message: null });
    });
  });

  describe('indent_level → parent_id backfill', () => {
    const seedItem = async (
      db: TestDatabase,
      item: { id: string; noteId: string; position: number; indent: number },
    ): Promise<void> => {
      await db.runAsync(
        `INSERT INTO note_items (id, note_id, text, completed, position, indent_level)
         VALUES (?, ?, ?, 0, ?, ?)`,
        [item.id, item.noteId, item.id, item.position, item.indent],
      );
    };

    it('attaches indented items to the nearest preceding top-level item', async () => {
      const db = await preVersionedInstall();
      await insertLegacyNote(db, { id: 'note1' });
      await seedItem(db, { id: 'item1', noteId: 'note1', position: 0, indent: 0 });
      await seedItem(db, { id: 'item2', noteId: 'note1', position: 1, indent: 1 });
      await seedItem(db, { id: 'item3', noteId: 'note1', position: 2, indent: 0 });
      await seedItem(db, { id: 'item4', noteId: 'note1', position: 3, indent: 1 });

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT id, parent_id FROM note_items ORDER BY position')).toEqual([
        { id: 'item1', parent_id: null },
        { id: 'item2', parent_id: 'item1' },
        { id: 'item3', parent_id: null },
        { id: 'item4', parent_id: 'item3' },
      ]);
    });

    it('does not carry a parent across notes', async () => {
      const db = await preVersionedInstall();
      await insertLegacyNote(db, { id: 'note1' });
      await insertLegacyNote(db, { id: 'note2' });
      await seedItem(db, { id: 'item1', noteId: 'note1', position: 0, indent: 0 });
      // First item of the next note is indented, with no top-level item of its own.
      await seedItem(db, { id: 'item2', noteId: 'note2', position: 0, indent: 1 });

      await migrateDatabase(db);

      expect(await db.getFirstAsync('SELECT parent_id FROM note_items WHERE id = ?', ['item2'])).toEqual({
        parent_id: null,
      });
    });

    it('leaves parent_id null when the install never had indent_level', async () => {
      const db = await preVersionedInstall();
      await db.execAsync('ALTER TABLE note_items DROP COLUMN indent_level');
      await insertLegacyNote(db, { id: 'note1' });
      await db.runAsync(
        `INSERT INTO note_items (id, note_id, text, completed, position) VALUES ('item1', 'note1', 'a', 0, 0)`,
      );

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT id, parent_id FROM note_items')).toEqual([
        { id: 'item1', parent_id: null },
      ]);
    });
  });

  describe('constraints the queries rely on', () => {
    // A mock enforces none of these, so nothing else in the suite would notice
    // if a migration dropped them.
    it('rejects a duplicate note id', async () => {
      const db = await freshlyMigratedDb();
      await db.runAsync(`INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('n1', 'u1', '', '')`);

      await expect(
        db.runAsync(`INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('n1', 'u1', '', '')`),
      ).rejects.toThrow(/UNIQUE constraint/i);
    });

    it('rejects a note_item whose note does not exist', async () => {
      const db = await freshlyMigratedDb();

      await expect(
        db.runAsync(`INSERT INTO note_items (id, note_id, text) VALUES ('i1', 'nope', 'x')`),
      ).rejects.toThrow(/FOREIGN KEY constraint/i);
    });

    it('cascades note_items and pending_image_uploads away with their note', async () => {
      const db = await freshlyMigratedDb();
      await db.runAsync(`INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('n1', 'u1', '', '')`);
      await db.runAsync(`INSERT INTO note_items (id, note_id, text) VALUES ('i1', 'n1', 'x')`);
      await db.runAsync(
        `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, created_at)
         VALUES ('up1', 'n1', 'file:///p', 'a.png', 'image/png', '')`,
      );

      await db.runAsync(`DELETE FROM notes WHERE id = 'n1'`);

      expect(await db.getAllAsync('SELECT id FROM note_items')).toEqual([]);
      expect(await db.getAllAsync('SELECT id FROM pending_image_uploads')).toEqual([]);
    });

    it('rejects a note with no user_id', async () => {
      const db = await freshlyMigratedDb();

      await expect(
        db.runAsync(`INSERT INTO notes (id, created_at, updated_at) VALUES ('n1', '', '')`),
      ).rejects.toThrow(/NOT NULL constraint/i);
    });

    it('applies the sync_queue defaults on a bare insert', async () => {
      const db = await freshlyMigratedDb();

      await db.runAsync(
        `INSERT INTO sync_queue (operation, endpoint, method, created_at)
         VALUES ('update', '/notes/n1', 'PATCH', '')`,
      );

      expect(await db.getFirstAsync('SELECT id, body, attempts FROM sync_queue')).toEqual({
        id: 1,
        body: null,
        attempts: 0,
      });
    });
  });

  describe('labels store backfill (issue #691)', () => {
    it('backfills the labels table from notes.labels_json, deduping by id', async () => {
      const db = await preVersionedInstall();
      await insertLegacyNote(db, {
        id: 'n1',
        labels_json: JSON.stringify([
          { id: 'l1', user_id: 'u1', name: 'Work', created_at: 'c1', updated_at: 'u1t' },
        ]),
      });
      await insertLegacyNote(db, {
        id: 'n2',
        labels_json: JSON.stringify([
          { id: 'l1', user_id: 'u1', name: 'Work', created_at: 'c1', updated_at: 'u1t' },
          { id: 'l2', user_id: 'u1', name: 'Home', created_at: 'c2', updated_at: 'u2t' },
        ]),
      });

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT id, user_id, name, created_at, updated_at FROM labels ORDER BY id')).toEqual([
        { id: 'l1', user_id: 'u1', name: 'Work', created_at: 'c1', updated_at: 'u1t' },
        { id: 'l2', user_id: 'u1', name: 'Home', created_at: 'c2', updated_at: 'u2t' },
      ]);
    });

    it('tolerates rows whose labels_json is malformed or not an array', async () => {
      const db = await preVersionedInstall();
      await insertLegacyNote(db, { id: 'n1', labels_json: 'not json' });
      await insertLegacyNote(db, { id: 'n2', labels_json: '5' });
      await insertLegacyNote(db, { id: 'n3', labels_json: '{}' });
      await insertLegacyNote(db, {
        id: 'n4',
        labels_json: JSON.stringify([{ id: 'l1', user_id: 'u1', name: 'Work' }]),
      });

      await migrateDatabase(db);

      // The one well-formed label still lands; absent timestamps default to ''.
      expect(await db.getAllAsync('SELECT id, name, created_at, updated_at FROM labels')).toEqual([
        { id: 'l1', name: 'Work', created_at: '', updated_at: '' },
      ]);
    });

    it('inserts nothing when there are no notes to backfill from', async () => {
      const db = await preVersionedInstall();

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT * FROM labels')).toEqual([]);
    });
  });
});
