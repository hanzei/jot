import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { getDatabaseNameForServer, initializeServerDatabase } from '../src/db/serverDatabase';
import { MIGRATIONS } from '../src/db/schema';
import { createTestDb, openNamedTestDb, type TestDatabase } from './helpers/testDb';

describe('server database isolation', () => {
  const mockSecureStore = SecureStore as unknown as {
    getItemAsync: jest.Mock;
    setItemAsync: jest.Mock;
  };
  const mockSQLite = SQLite as unknown as {
    openDatabaseAsync: jest.Mock;
    backupDatabaseAsync: jest.Mock;
    defaultDatabaseDirectory: string;
  };
  const fs = globalThis.mockFileSystem;
  const store = new Map<string, string>();

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    mockSecureStore.getItemAsync.mockImplementation(async (key: string) => store.get(key) ?? null);
    mockSecureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
    fs.reset();
    mockSQLite.defaultDatabaseDirectory = 'file:///db';
  });

  const userVersion = async (db: TestDatabase): Promise<number> => {
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    return row?.user_version ?? 0;
  };

  /** Put a legacy `jot.db` on disk, with the schema and rows it would have held. */
  const seedLegacyDatabase = async (): Promise<TestDatabase> => {
    const legacyDb = openNamedTestDb('jot.db');
    await legacyDb.execAsync(`
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
      CREATE TABLE sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO notes (id, user_id, title, created_at, updated_at)
        VALUES ('legacy1', 'u1', 'Legacy note', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
        VALUES ('update_note', '/notes/legacy1', 'PATCH', '{}', '2026-01-01T00:00:00Z');
    `);
    // The database file and its WAL/SHM sidecars, all of which must be archived.
    for (const uri of ['file:///db/jot.db', 'file:///db/jot.db-wal', 'file:///db/jot.db-shm']) {
      fs.files.set(uri, 'sqlite-bytes');
    }
    return legacyDb;
  };

  it('derives per-server database names', () => {
    expect(getDatabaseNameForServer('srv_1234abcd')).toBe('jot_srv_1234abcd.db');
    expect(getDatabaseNameForServer(null)).toBe('jot_default.db');
  });

  it('runs schema migration and marks legacy migration complete when no legacy db exists', async () => {
    const targetDb = createTestDb();

    await initializeServerDatabase(targetDb, 'srv_1234abcd');

    expect(await userVersion(targetDb)).toBe(MIGRATIONS.length);
    expect(store.get('jot_sqlite_legacy_migrated_v1')).toBe('1');
    expect(mockSQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });

  it('skips legacy migration for no active server id', async () => {
    const targetDb = createTestDb();

    await initializeServerDatabase(targetDb, null);

    expect(await userVersion(targetDb)).toBe(MIGRATIONS.length);
    expect(store.has('jot_sqlite_legacy_migrated_v1')).toBe(false);
  });

  it('copies legacy rows into the target db and archives the legacy file once', async () => {
    const targetDb = createTestDb();
    const legacyDb = await seedLegacyDatabase();

    await initializeServerDatabase(targetDb, 'srv_1234abcd');

    expect(mockSQLite.openDatabaseAsync).toHaveBeenCalledWith('jot.db');
    expect(legacyDb.execAsync).toHaveBeenCalledWith('PRAGMA wal_checkpoint(FULL);');
    expect(legacyDb.closeAsync).toHaveBeenCalled();

    // The legacy rows are now in the target, and the restored (pre-versioned)
    // schema has been brought up to the current version on top of them.
    expect(await targetDb.getAllAsync('SELECT id, title FROM notes')).toEqual([
      { id: 'legacy1', title: 'Legacy note' },
    ]);
    expect(await targetDb.getAllAsync('SELECT endpoint FROM sync_queue')).toEqual([
      { endpoint: '/notes/legacy1' },
    ]);
    expect(await userVersion(targetDb)).toBe(MIGRATIONS.length);

    // The db and both sidecars were moved aside to a timestamped archive name.
    expect(fs.files.has('file:///db/jot.db')).toBe(false);
    expect(fs.files.has('file:///db/jot.db-wal')).toBe(false);
    expect(fs.files.has('file:///db/jot.db-shm')).toBe(false);
    expect([...fs.files.keys()].filter((uri) => uri.includes('jot_legacy_'))).toHaveLength(3);
    expect(store.get('jot_sqlite_legacy_migrated_v1')).toBe('1');
  });

  it('leaves an already-populated target untouched and just archives the legacy file', async () => {
    const targetDb = createTestDb();
    await seedLegacyDatabase();
    // The target already holds this install's data, so the legacy copy must not
    // overwrite it.
    await initializeServerDatabase(targetDb, null);
    await targetDb.runAsync(
      `INSERT INTO notes (id, user_id, title, created_at, updated_at)
       VALUES ('current1', 'u1', 'Current note', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
    );

    await initializeServerDatabase(targetDb, 'srv_1234abcd');

    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(await targetDb.getAllAsync('SELECT id FROM notes')).toEqual([{ id: 'current1' }]);
    expect(fs.files.has('file:///db/jot.db')).toBe(false);
    expect(store.get('jot_sqlite_legacy_migrated_v1')).toBe('1');
  });

  it('does not re-run the legacy migration once the marker is set', async () => {
    store.set('jot_sqlite_legacy_migrated_v1', '1');
    const targetDb = createTestDb();
    await seedLegacyDatabase();

    await initializeServerDatabase(targetDb, 'srv_1234abcd');

    expect(mockSQLite.openDatabaseAsync).not.toHaveBeenCalled();
    expect(await targetDb.getAllAsync('SELECT id FROM notes')).toEqual([]);
    // The legacy file is left in place for the run that already claimed it.
    expect(fs.files.has('file:///db/jot.db')).toBe(true);
  });
});
