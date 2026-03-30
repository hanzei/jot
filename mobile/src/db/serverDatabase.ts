import { backupDatabaseAsync, defaultDatabaseDirectory, openDatabaseAsync, SQLiteDatabase } from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { migrateDatabase } from './schema';

const DEFAULT_DATABASE_NAME = 'jot_default.db';
const LEGACY_DATABASE_NAME = 'jot.db';
const LEGACY_MIGRATION_MARKER_KEY = 'jot_sqlite_legacy_migrated_v1';

function joinPath(directory: string, fileName: string): string {
  if (directory.endsWith('/')) {
    return `${directory}${fileName}`;
  }
  return `${directory}/${fileName}`;
}

function getDatabaseFileUri(databaseName: string): string | null {
  if (!defaultDatabaseDirectory || typeof defaultDatabaseDirectory !== 'string') {
    return null;
  }
  return joinPath(defaultDatabaseDirectory, databaseName);
}

async function tableExists(db: SQLiteDatabase, tableName: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ name: string }>(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    ['table', tableName],
  );
  return Boolean(row?.name);
}

async function getRowCountIfExists(db: SQLiteDatabase, tableName: string): Promise<number> {
  if (!(await tableExists(db, tableName))) {
    return 0;
  }
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return row?.count ?? 0;
}

async function hasData(db: SQLiteDatabase): Promise<boolean> {
  const notesCount = await getRowCountIfExists(db, 'notes');
  const queueCount = await getRowCountIfExists(db, 'sync_queue');
  return notesCount > 0 || queueCount > 0;
}

async function archiveLegacyDbIfPresent(): Promise<void> {
  const legacyUri = getDatabaseFileUri(LEGACY_DATABASE_NAME);
  if (!legacyUri) {
    return;
  }

  const legacyInfo = await FileSystem.getInfoAsync(legacyUri);
  if (!legacyInfo.exists) {
    return;
  }

  const timestamp = Date.now();
  const archiveBaseName = `jot_legacy_${timestamp}.db`;
  const archiveUri = getDatabaseFileUri(archiveBaseName);
  if (!archiveUri) {
    return;
  }

  await FileSystem.moveAsync({ from: legacyUri, to: archiveUri });

  // Best-effort move sidecar WAL/SHM files if present.
  for (const suffix of ['-wal', '-shm']) {
    const sidecarFrom = `${legacyUri}${suffix}`;
    const sidecarTo = `${archiveUri}${suffix}`;
    const sidecarInfo = await FileSystem.getInfoAsync(sidecarFrom);
    if (sidecarInfo.exists) {
      try {
        await FileSystem.moveAsync({ from: sidecarFrom, to: sidecarTo });
      } catch (error) {
        console.warn(`Failed to move SQLite sidecar file (${suffix}) during archive:`, error);
      }
    }
  }
}

async function migrateLegacySqliteToServerDb(targetDb: SQLiteDatabase, activeServerId: string): Promise<void> {
  const marker = await SecureStore.getItemAsync(LEGACY_MIGRATION_MARKER_KEY);
  if (marker === '1') {
    return;
  }

  const legacyUri = getDatabaseFileUri(LEGACY_DATABASE_NAME);
  if (!legacyUri) {
    await SecureStore.setItemAsync(LEGACY_MIGRATION_MARKER_KEY, '1');
    return;
  }

  const legacyInfo = await FileSystem.getInfoAsync(legacyUri);
  if (!legacyInfo.exists) {
    await SecureStore.setItemAsync(LEGACY_MIGRATION_MARKER_KEY, '1');
    return;
  }

  const targetHasRows = await hasData(targetDb);
  if (targetHasRows) {
    await archiveLegacyDbIfPresent();
    await SecureStore.setItemAsync(LEGACY_MIGRATION_MARKER_KEY, '1');
    return;
  }

  const legacyDb = await openDatabaseAsync(LEGACY_DATABASE_NAME);
  try {
    await legacyDb.execAsync('PRAGMA wal_checkpoint(FULL);');
    const shouldMigrate = await hasData(legacyDb);
    if (shouldMigrate) {
      await backupDatabaseAsync({ sourceDatabase: legacyDb, destDatabase: targetDb });
      await migrateDatabase(targetDb);
    }
  } finally {
    await legacyDb.closeAsync();
  }

  await archiveLegacyDbIfPresent();
  await SecureStore.setItemAsync(LEGACY_MIGRATION_MARKER_KEY, '1');

  console.info(`SQLite migration complete for active server ${activeServerId}`);
}

export function getDatabaseNameForServer(serverId: string | null): string {
  if (!serverId) {
    return DEFAULT_DATABASE_NAME;
  }
  return `jot_${serverId}.db`;
}

export async function initializeServerDatabase(db: SQLiteDatabase, activeServerId: string | null): Promise<void> {
  await migrateDatabase(db);
  if (!activeServerId) {
    return;
  }
  await migrateLegacySqliteToServerDb(db, activeServerId);
}
