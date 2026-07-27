import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { getDatabaseNameForServer, initializeServerDatabase } from '../src/db/serverDatabase';

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

  const makeDb = () => ({
    execAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue({ count: 0 }),
    getAllAsync: jest.fn().mockResolvedValue([{ name: 'created_at' }, { name: 'updated_at' }, { name: 'assigned_to' }]),
    runAsync: jest.fn().mockResolvedValue({}),
  });

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

  it('derives per-server database names', () => {
    expect(getDatabaseNameForServer('srv_1234abcd')).toBe('jot_srv_1234abcd.db');
    expect(getDatabaseNameForServer(null)).toBe('jot_default.db');
  });

  it('runs schema migration and marks legacy migration complete when no legacy db exists', async () => {
    const targetDb = makeDb();
    await initializeServerDatabase(targetDb as unknown as Parameters<typeof initializeServerDatabase>[0], 'srv_1234abcd');

    expect(targetDb.execAsync).toHaveBeenCalled();
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('jot_sqlite_legacy_migrated_v1', '1');
    expect(mockSQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });

  it('skips legacy migration for no active server id', async () => {
    const targetDb = makeDb();
    await initializeServerDatabase(targetDb as unknown as Parameters<typeof initializeServerDatabase>[0], null);

    expect(targetDb.execAsync).toHaveBeenCalled();
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalledWith('jot_sqlite_legacy_migrated_v1', '1');
  });

  it('backs up legacy db into target db and archives legacy file once', async () => {
    const targetDb = makeDb();
    const legacyDb = makeDb();
    // target is empty
    targetDb.getFirstAsync.mockResolvedValue({ count: 0 });
    // legacy has notes/sync rows
    legacyDb.getFirstAsync
      .mockResolvedValueOnce({ name: 'notes' })
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ name: 'sync_queue' })
      .mockResolvedValueOnce({ count: 1 });

    mockSQLite.openDatabaseAsync.mockResolvedValue(legacyDb);
    // A legacy database plus its WAL/SHM sidecars, all of which must be archived.
    for (const uri of ['file:///db/jot.db', 'file:///db/jot.db-wal', 'file:///db/jot.db-shm']) {
      fs.files.set(uri, 'sqlite-bytes');
    }

    await initializeServerDatabase(targetDb as unknown as Parameters<typeof initializeServerDatabase>[0], 'srv_1234abcd');

    expect(mockSQLite.openDatabaseAsync).toHaveBeenCalledWith('jot.db');
    expect(legacyDb.execAsync).toHaveBeenCalledWith('PRAGMA wal_checkpoint(FULL);');
    expect(mockSQLite.backupDatabaseAsync).toHaveBeenCalledWith({
      sourceDatabase: legacyDb,
      destDatabase: targetDb,
    });
    expect(legacyDb.closeAsync).toHaveBeenCalled();
    // The db and both sidecars were moved aside to a timestamped archive name.
    expect(fs.files.has('file:///db/jot.db')).toBe(false);
    expect(fs.files.has('file:///db/jot.db-wal')).toBe(false);
    expect(fs.files.has('file:///db/jot.db-shm')).toBe(false);
    const archived = [...fs.files.keys()].filter((uri) => uri.includes('jot_legacy_'));
    expect(archived).toHaveLength(3);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('jot_sqlite_legacy_migrated_v1', '1');
  });
});
