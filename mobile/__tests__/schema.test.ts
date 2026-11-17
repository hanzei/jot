import { migrateDatabase, MIGRATIONS } from '../src/db/schema';
import { createMigratedTestDb, createTestDb, type TestDatabase } from './helpers/testDb';

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

const freshlyMigratedDb = createMigratedTestDb;

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
        'account_owner',
        'dead_letter',
        'dead_letter_keys',
        'labels',
        'note_items',
        'notes',
        'pending_image_uploads',
        'sync_queue',
        'sync_queue_keys',
        'users',
      ]);
      expect(await indexNames(db)).toEqual([
        'idx_dead_letter_keys_key',
        'idx_note_items_note_id',
        'idx_notes_list',
        'idx_pending_image_uploads_note_id',
        'idx_sync_queue_keys_key',
      ]);
    });

    it('produces the columns the queries rely on', async () => {
      const db = await freshlyMigratedDb();

      expect(await columnNames(db, 'notes')).toEqual(
        expect.arrayContaining(['version', 'images_json', 'sync_state', 'labels_json', 'shared_with_json', 'unread', 'public_link_json']),
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
          await MIGRATIONS[i]!(db);
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
      await MIGRATIONS[0]!(db);
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

  describe('set-completed queue rewrite (issue #1172)', () => {
    const seed = async (db: TestDatabase, table: 'sync_queue' | 'dead_letter', operation: string, endpoint: string, body: string | null) => {
      if (table === 'sync_queue') {
        await db.runAsync(
          `INSERT INTO sync_queue (operation, endpoint, method, body, created_at) VALUES (?, ?, 'POST', ?, '2026-01-01T00:00:00Z')`,
          [operation, endpoint, body],
        );
      } else {
        await db.runAsync(
          `INSERT INTO dead_letter (operation, endpoint, method, body, status, created_at, failed_at)
           VALUES (?, ?, 'POST', ?, 404, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          [operation, endpoint, body],
        );
      }
    };

    it.each(['sync_queue', 'dead_letter'] as const)('rewrites unsent toggle and uncheck-all rows in %s', async (table) => {
      const db = createTestDb();
      for (let i = 0; i < 7; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      await seed(db, table, 'toggleItemCompleted', '/notes/n1/items/i1/toggle-completed', '{"completed":true}');
      await seed(db, table, 'toggleItemCompleted', '/notes/n1/items/i2/toggle-completed', '{"completed":false}');
      await seed(db, table, 'uncheckAllItems', '/notes/n1/items/set-completed', '{"item_ids":["a","b"],"completed":false}');
      await seed(db, table, 'update', '/notes/n1', '{"title":"x"}');

      await migrateDatabase(db);

      const rows = await db.getAllAsync<{ operation: string; endpoint: string; body: string }>(
        `SELECT operation, endpoint, body FROM ${table} ORDER BY id`,
      );
      expect(rows.map((r) => ({ operation: r.operation, endpoint: r.endpoint, body: JSON.parse(r.body) }))).toEqual([
        { operation: 'setItemsCompleted', endpoint: '/notes/n1/items/set-completed', body: { item_ids: ['i1'], completed: true } },
        { operation: 'setItemsCompleted', endpoint: '/notes/n1/items/set-completed', body: { item_ids: ['i2'], completed: false } },
        { operation: 'setItemsCompleted', endpoint: '/notes/n1/items/set-completed', body: { item_ids: ['a', 'b'], completed: false } },
        { operation: 'update', endpoint: '/notes/n1', body: { title: 'x' } },
      ]);
    });
  });

  describe('legacy createLabel local_id rewrite', () => {
    it('gives placeholder-id createLabel rows a real id and re-points later ops', async () => {
      const db = createTestDb();
      for (let i = 0; i < 10; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      const seed = (table: string, operation: string, endpoint: string, method: string, body: string) =>
        db.runAsync(
          `INSERT INTO ${table} (operation, endpoint, method, body, ${table === 'sync_queue' ? 'created_at' : 'status, created_at, failed_at'})
           VALUES (?, ?, ?, ?, ${table === 'sync_queue' ? "'2026-01-01T00:00:00Z'" : "409, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'"})`,
          [operation, endpoint, method, body],
        );
      await seed('sync_queue', 'createLabel', '/labels', 'POST', '{"local_id":"local_1","name":"Work"}');
      await seed('sync_queue', 'deleteLabel', '/labels/local_1', 'DELETE', 'null');
      await seed('sync_queue', 'createLabel', '/labels', 'POST', '{"id":"Real0000000000000000A","name":"Home"}');

      await migrateDatabase(db);

      const rows = await db.getAllAsync<{ operation: string; endpoint: string; body: string }>(
        'SELECT operation, endpoint, body FROM sync_queue ORDER BY id',
      );
      const create = JSON.parse(rows[0]!.body) as { id: string; local_id?: string; name: string };
      expect(create.local_id).toBeUndefined();
      expect(create.name).toBe('Work');
      expect(create.id).not.toBe('local_1');
      expect(rows[1]!.endpoint).toBe(`/labels/${create.id}`);
      expect(rows[2]!.body).toBe('{"id":"Real0000000000000000A","name":"Home"}');
      // Migration 13 keys the rows as rewritten.
      expect(await db.getAllAsync('SELECT entry_id, key FROM sync_queue_keys ORDER BY entry_id')).toEqual([
        { entry_id: 1, key: `label:${create.id}` },
        { entry_id: 2, key: `label:${create.id}` },
        { entry_id: 3, key: 'label:Real0000000000000000A' },
      ]);
    });
  });

  describe('queue keys backfill (#1282)', () => {
    /** A database at user_version 12 — every table but the key tables. */
    async function beforeKeys(): Promise<TestDatabase> {
      const db = createTestDb();
      for (let i = 0; i < 12; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      return db;
    }

    const insertRow = async (
      db: TestDatabase,
      table: 'sync_queue' | 'dead_letter',
      operation: string,
      endpoint: string,
      method: string,
      body: unknown = null,
    ): Promise<number> => {
      const result = await db.runAsync(
        table === 'sync_queue'
          ? `INSERT INTO sync_queue (operation, endpoint, method, body, created_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`
          : `INSERT INTO dead_letter (operation, endpoint, method, body, status, created_at, failed_at)
             VALUES (?, ?, ?, ?, 409, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        [operation, endpoint, method, body === null ? null : JSON.stringify(body)],
      );
      return result.lastInsertRowId;
    };

    const keysOf = async (db: TestDatabase, table: 'sync_queue_keys' | 'dead_letter_keys', id: number): Promise<string[]> => {
      const column = table === 'sync_queue_keys' ? 'entry_id' : 'dead_letter_id';
      const rows = await db.getAllAsync<{ key: string; read_only: number }>(
        `SELECT key, read_only FROM ${table} WHERE ${column} = ? ORDER BY key`,
        [id],
      );
      return rows.map((r) => (r.read_only ? `${r.key} (read)` : r.key));
    };

    // Every queue operation, as its hook (or the local→server upgrade seed)
    // queued it before keys existed, with the keys the backfill must give it.
    const everyOperation: [string, string, string, unknown, string[]][] = [
      ['create', '/notes', 'POST', { id: 'n1', note_type: 'text', content: '', labels: ['Work', 'Unknown'] }, ['label:l1', 'note:n1']],
      ['duplicate', '/notes/src/duplicate', 'POST', { id: 'clone' }, ['note:clone', 'note:src (read)']],
      ['update', '/notes/n1', 'PATCH', { content: 'x' }, ['note:n1']],
      ['convertNoteType', '/notes/n1/convert', 'POST', { note_type: 'list' }, ['note:n1']],
      ['delete', '/notes/n1', 'DELETE', null, ['note:n1']],
      ['restore', '/notes/n1/restore', 'POST', null, ['note:n1']],
      ['permanentDelete', '/notes/n1?permanent=true', 'DELETE', null, ['note:n1']],
      ['reorder', '/notes/reorder', 'POST', { note_ids: ['a', 'b', 'a'] }, ['note:a', 'note:b']],
      ['createItem', '/notes/n1/items', 'POST', { id: 'i1', text: 'x' }, ['note:n1']],
      ['updateItem', '/notes/n1/items/i1', 'PATCH', { text: 'y' }, ['note:n1']],
      ['deleteItem', '/notes/n1/items/i1', 'DELETE', null, ['note:n1']],
      ['reorderItems', '/notes/n1/items/reorder', 'POST', { item_ids: ['i1'] }, ['note:n1']],
      ['setItemsCompleted', '/notes/n1/items/set-completed', 'POST', { item_ids: ['i1'], completed: true }, ['note:n1']],
      ['deleteCompletedItems', '/notes/n1/items/delete', 'POST', { item_ids: ['i1'] }, ['note:n1']],
      ['share', '/notes/n1/share', 'POST', { user_id: 'u2' }, ['note:n1']],
      ['unshare', '/notes/n1/shares/u2', 'DELETE', null, ['note:n1']],
      ['createLabel', '/labels', 'POST', { id: 'l2', name: 'Home' }, ['label:l2']],
      ['renameLabel', '/labels/l1', 'PATCH', { name: 'Job' }, ['label:l1']],
      ['deleteLabel', '/labels/l1', 'DELETE', null, ['label:l1']],
      ['addLabelToNote', '/notes/n1/labels', 'POST', { name: 'work' }, ['label:l1', 'note:n1']],
      ['addLabelToNote', '/notes/n1/labels/l2', 'POST', null, ['label:l2', 'note:n1']],
      ['removeLabelFromNote', '/notes/n1/labels/l1', 'DELETE', null, ['label:l1', 'note:n1']],
      ['updateSettings', '/users/me', 'PATCH', { theme: 'dark' }, ['settings']],
      ['removeImage', '/images/img1', 'DELETE', { note_id: 'n1' }, ['note:n1']],
      ['markViewed', '/notes/n1/viewed', 'POST', { viewed_at: '2026-01-01T00:00:00Z' }, ['note:n1']],
    ];

    it.each(['sync_queue', 'dead_letter'] as const)('backfills the keys of every operation type in %s', async (table) => {
      const db = await beforeKeys();
      await db.runAsync(`INSERT INTO labels (id, user_id, name) VALUES ('l1', 'u1', 'Work')`);
      const ids: number[] = [];
      for (const [operation, endpoint, method, body] of everyOperation) {
        ids.push(await insertRow(db, table, operation, endpoint, method, body));
      }

      await migrateDatabase(db);

      const keyTable = table === 'sync_queue' ? 'sync_queue_keys' : 'dead_letter_keys';
      const actual = await Promise.all(ids.map((id) => keysOf(db, keyTable, id)));
      expect(actual).toEqual(everyOperation.map(([, , , , keys]) => keys));
    });

    it('resolves a label renamed since by the name its queued create used', async () => {
      const db = await beforeKeys();
      // Created offline as 'Work', added to n1 by that name, then renamed.
      await db.runAsync(`INSERT INTO labels (id, user_id, name) VALUES ('l9', 'u1', 'Job')`);
      await insertRow(db, 'sync_queue', 'createLabel', '/labels', 'POST', { id: 'l9', name: 'Work' });
      const add = await insertRow(db, 'sync_queue', 'addLabelToNote', '/notes/n1/labels', 'POST', { name: 'Work' });
      await insertRow(db, 'sync_queue', 'renameLabel', '/labels/l9', 'PATCH', { name: 'Job' });

      await migrateDatabase(db);

      expect(await keysOf(db, 'sync_queue_keys', add)).toEqual(['label:l9', 'note:n1']);
    });

    it('keys what the endpoint names when a body does not parse', async () => {
      const db = await beforeKeys();
      await db.runAsync(
        `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
         VALUES ('update', '/notes/n1', 'PATCH', 'not-json', ''), ('create', '/notes', 'POST', 'not-json', '')`,
      );

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT entry_id, key FROM sync_queue_keys')).toEqual([{ entry_id: 1, key: 'note:n1' }]);
    });

    it('is idempotent when an interrupted run is redone', async () => {
      const db = await beforeKeys();
      const id = await insertRow(db, 'sync_queue', 'reorder', '/notes/reorder', 'POST', { note_ids: ['a', 'b'] });

      await MIGRATIONS[12]!(db);
      await migrateDatabase(db);

      expect(await keysOf(db, 'sync_queue_keys', id)).toEqual(['note:a', 'note:b']);
    });

    it('drops an entry\'s keys with the entry', async () => {
      const db = await beforeKeys();
      const id = await insertRow(db, 'sync_queue', 'update', '/notes/n1', 'PATCH', { content: 'x' });
      const dl = await insertRow(db, 'dead_letter', 'update', '/notes/n1', 'PATCH', { content: 'x' });
      await migrateDatabase(db);

      await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [id]);
      await db.runAsync('DELETE FROM dead_letter WHERE id = ?', [dl]);

      expect(await db.getAllAsync('SELECT * FROM sync_queue_keys')).toEqual([]);
      expect(await db.getAllAsync('SELECT * FROM dead_letter_keys')).toEqual([]);
    });
  });

  describe('queue attempt reset (502/503/504 no longer charged)', () => {
    it('starts queued entries over and leaves errored uploads and dead-letter rows alone', async () => {
      const db = createTestDb();
      for (let i = 0; i < 8; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      await db.runAsync("INSERT INTO sync_queue (operation, endpoint, method, created_at, attempts) VALUES ('update', '/notes/n1', 'PATCH', '2026-01-01T00:00:00Z', 4)");
      await db.runAsync("INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('n1', 'u1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
      for (const [id, status] of [['queued-up', 'queued'], ['errored-up', 'error']] as const) {
        await db.runAsync(
          `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, status, created_at, attempts)
           VALUES (?, 'n1', 'file:///x', 'x.png', 'image/png', ?, '2026-01-01T00:00:00Z', 5)`,
          [id, status],
        );
      }
      await db.runAsync(
        `INSERT INTO dead_letter (operation, endpoint, method, status, created_at, failed_at, attempts)
         VALUES ('update', '/notes/n1', 'PATCH', 503, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 5)`,
      );

      await migrateDatabase(db);

      // The queued upload has since moved into the sync queue (#1288).
      expect(await db.getAllAsync('SELECT operation, attempts FROM sync_queue ORDER BY id')).toEqual([
        { operation: 'update', attempts: 0 },
        { operation: 'uploadImage', attempts: 0 },
      ]);
      expect(await db.getAllAsync('SELECT id, attempts FROM pending_image_uploads ORDER BY id')).toEqual([
        { id: 'errored-up', attempts: 5 },
      ]);
      expect(await db.getAllAsync('SELECT attempts FROM dead_letter')).toEqual([{ attempts: 5 }]);
    });
  });

  describe('processing-error counters (#1283)', () => {
    it('adds them to queued rows, starting at 0, and keeps their attempts', async () => {
      const db = createTestDb();
      for (let i = 0; i < 13; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      await db.runAsync("INSERT INTO sync_queue (operation, endpoint, method, created_at, attempts) VALUES ('update', '/notes/n1', 'PATCH', '2026-01-01T00:00:00Z', 4)");
      await db.runAsync("INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('n1', 'u1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
      await db.runAsync(
        `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, status, created_at, attempts)
         VALUES ('up', 'n1', 'file:///x', 'x.png', 'image/png', 'queued', '2026-01-01T00:00:00Z', 3)`,
      );

      await migrateDatabase(db);

      // The queued upload has since moved into the sync queue (#1288).
      expect(await db.getAllAsync('SELECT attempts, processing_errors FROM sync_queue ORDER BY id'))
        .toEqual([{ attempts: 4, processing_errors: 0 }, { attempts: 3, processing_errors: 0 }]);
    });
  });

  describe('pending note versions (#1284)', () => {
    it('resets a note still pending its create to version 1 and leaves the rest', async () => {
      const db = createTestDb();
      for (let i = 0; i < 14; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      // An offline duplicate from before #1284 kept its source's version.
      await db.runAsync(
        `INSERT INTO notes (id, user_id, version, sync_state, created_at, updated_at) VALUES
         ('dup', 'u1', 7, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
         ('src', 'u1', 7, 'synced', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      );

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT id, version FROM notes ORDER BY id'))
        .toEqual([{ id: 'dup', version: 1 }, { id: 'src', version: 7 }]);
    });
  });

  describe('image uploads into the sync queue (#1288)', () => {
    it('moves queued uploads behind the queued ops, oldest first, and keeps failed ones', async () => {
      const db = createTestDb();
      for (let i = 0; i < 15; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      await db.runAsync("INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('n1', 'u1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
      const update = await db.runAsync("INSERT INTO sync_queue (operation, endpoint, method, created_at) VALUES ('update', '/notes/n1', 'PATCH', '2026-01-03T00:00:00Z')");
      await db.runAsync("INSERT INTO sync_queue_keys (entry_id, key) VALUES (?, 'note:n1')", [update.lastInsertRowId]);
      for (const [id, status, createdAt] of [
        ['later', 'queued', '2026-01-02T00:00:00Z'],
        ['earlier', 'queued', '2026-01-01T00:00:00Z'],
        ['failed', 'error', '2026-01-01T00:00:00Z'],
      ] as const) {
        await db.runAsync(
          `INSERT INTO pending_image_uploads (id, note_id, local_path, filename, mime_type, size_bytes, status, error_message, created_at, attempts, processing_errors)
           VALUES (?, 'n1', ?, 'x.png', 'image/png', 10, ?, NULL, ?, 2, 1)`,
          [id, `file:///${id}`, status, createdAt],
        );
      }

      await migrateDatabase(db);

      expect(await db.getAllAsync(
        `SELECT q.operation, q.endpoint, q.method, q.body, q.created_at, q.attempts, q.processing_errors, k.key
         FROM sync_queue q JOIN sync_queue_keys k ON k.entry_id = q.id ORDER BY q.id`,
      )).toEqual([
        { operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: null, created_at: '2026-01-03T00:00:00Z', attempts: 0, processing_errors: 0, key: 'note:n1' },
        ...['earlier', 'later'].map((id) => ({
          operation: 'uploadImage',
          endpoint: '/notes/n1/images',
          method: 'POST',
          body: JSON.stringify({ id, local_path: `file:///${id}`, filename: 'x.png', mime_type: 'image/png', size_bytes: 10 }),
          created_at: id === 'earlier' ? '2026-01-01T00:00:00Z' : '2026-01-02T00:00:00Z',
          attempts: 2,
          processing_errors: 1,
          key: 'note:n1',
        })),
      ]);
      expect(await db.getAllAsync('SELECT id, status FROM pending_image_uploads')).toEqual([{ id: 'failed', status: 'error' }]);
    });
  });

  describe('send attempts (#1268)', () => {
    it('counts every row queued before the column as sent', async () => {
      const db = createTestDb();
      for (let i = 0; i < 16; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      await db.runAsync("INSERT INTO sync_queue (operation, endpoint, method, created_at) VALUES ('create', '/notes', 'POST', '2026-01-01T00:00:00Z')");

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT send_attempted FROM sync_queue')).toEqual([{ send_attempted: 1 }]);
      await db.runAsync("INSERT INTO sync_queue (operation, endpoint, method, created_at) VALUES ('create', '/notes', 'POST', '2026-01-02T00:00:00Z')");
      expect(await db.getAllAsync('SELECT send_attempted FROM sync_queue ORDER BY id')).toEqual([{ send_attempted: 1 }, { send_attempted: 0 }]);
    });
  });

  describe('retry waits (#1301)', () => {
    it('adds the wait and failure-run columns, starting every existing row with neither', async () => {
      const db = createTestDb();
      for (let i = 0; i < 17; i++) {
        await MIGRATIONS[i]!(db);
        await db.runAsync(`PRAGMA user_version = ${i + 1}`);
      }
      await db.runAsync("INSERT INTO sync_queue (operation, endpoint, method, created_at, attempts) VALUES ('update', '/notes/a', 'PATCH', '2026-01-01T00:00:00Z', 9)");

      await migrateDatabase(db);

      expect(await db.getAllAsync('SELECT attempts, next_attempt_at, first_failed_at, spaced_failures, last_spaced_failure_at FROM sync_queue'))
        .toEqual([{ attempts: 9, next_attempt_at: null, first_failed_at: null, spaced_failures: 0, last_spaced_failure_at: null }]);
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
        expect(upgraded[table]).toEqual(expect.arrayContaining(fresh[table]!));
      }
    });

    it('adds the columns missing from notes', async () => {
      const db = await preVersionedInstall();

      await migrateDatabase(db);

      expect(await columnNames(db, 'notes')).toEqual(
        expect.arrayContaining(['sync_state', 'version', 'images_json', 'unread', 'public_link_json']),
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
