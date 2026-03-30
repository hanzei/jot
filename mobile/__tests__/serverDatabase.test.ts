import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { getDatabaseNameForServer, initializeServerDatabase } from '../src/db/serverDatabase';
import { migrateDatabase } from '../src/db/schema';

jest.mock('../src/db/schema', () => ({
  migrateDatabase: jest.fn().mockResolvedValue(undefined),
}));

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
  const mockFs = FileSystem as unknown as {
    getInfoAsync: jest.Mock;
    moveAsync: jest.Mock;
  };
  const mockMigrateDatabase = migrateDatabase as jest.Mock;

  const store = new Map<string, string>();

  const makeDb = () => ({
    execAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue({ count: 0 }),
    runAsync: jest.fn().mockResolvedValue({}),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    mockSecureStore.getItemAsync.mockImplementation(async (key: string) => store.get(key) ?? null);
    mockSecureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
    mockFs.getInfoAsync.mockResolvedValue({ exists: false });
    mockFs.moveAsync.mockResolvedValue(undefined);
    mockSQLite.defaultDatabaseDirectory = 'file:///db';
  });

  it('derives per-server database names', () => {
    expect(getDatabaseNameForServer('srv_1234abcd')).toBe('jot_srv_1234abcd.db');
    expect(getDatabaseNameForServer(null)).toBe('jot_default.db');
  });

  it('runs schema migration and marks legacy migration complete when no legacy db exists', async () => {
    const targetDb = makeDb();
    await initializeServerDatabase(targetDb as unknown as Parameters<typeof initializeServerDatabase>[0], 'srv_1234abcd');

    expect(mockMigrateDatabase).toHaveBeenCalledWith(targetDb);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('jot_sqlite_legacy_migrated_v1', '1');
    expect(mockSQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });

  it('skips legacy migration for no active server id', async () => {
    const targetDb = makeDb();
    await initializeServerDatabase(targetDb as unknown as Parameters<typeof initializeServerDatabase>[0], null);

    expect(mockMigrateDatabase).toHaveBeenCalledWith(targetDb);
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
    mockFs.getInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === 'file:///db/jot.db') return { exists: true };
      if (uri === 'file:///db/jot.db-wal') return { exists: true };
      if (uri === 'file:///db/jot.db-shm') return { exists: true };
      return { exists: false };
    });

    await initializeServerDatabase(targetDb as unknown as Parameters<typeof initializeServerDatabase>[0], 'srv_1234abcd');

    expect(mockSQLite.openDatabaseAsync).toHaveBeenCalledWith('jot.db');
    expect(legacyDb.execAsync).toHaveBeenCalledWith('PRAGMA wal_checkpoint(FULL);');
    expect(mockSQLite.backupDatabaseAsync).toHaveBeenCalledWith({
      sourceDatabase: legacyDb,
      destDatabase: targetDb,
    });
    expect(legacyDb.closeAsync).toHaveBeenCalled();
    expect(mockFs.moveAsync).toHaveBeenCalledTimes(3);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('jot_sqlite_legacy_migrated_v1', '1');
  });
});
