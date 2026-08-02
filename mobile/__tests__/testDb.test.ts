/**
 * Tests for the test harness itself (`helpers/testDb.ts`). The adapter is now
 * doing real work — transactions, foreign-key deferral, handle tracking — and a
 * bug in it would show up as confusing failures spread across other suites.
 */

import { backupTestDb, createMigratedTestDb, createTestDb } from './helpers/testDb';

describe('backupTestDb', () => {
  /** A source whose child table is created *before* its parent. */
  async function childFirstSource() {
    const source = createTestDb();
    await source.execAsync(`
      CREATE TABLE note_items (id TEXT PRIMARY KEY, note_id TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE);
      CREATE TABLE notes (id TEXT PRIMARY KEY);
      INSERT INTO notes (id) VALUES ('n1');
      INSERT INTO note_items (id, note_id) VALUES ('i1', 'n1');
    `);
    return source;
  }

  it('copies a child table listed before its parent', async () => {
    // Rows are copied in sqlite_master order, so the child is filled before the
    // parent exists. Without deferred foreign keys this fails outright.
    const dest = createTestDb();

    await backupTestDb(await childFirstSource(), dest);

    expect(await dest.getAllAsync('SELECT id FROM notes')).toEqual([{ id: 'n1' }]);
    expect(await dest.getAllAsync('SELECT id FROM note_items')).toEqual([{ id: 'i1' }]);
  });

  it('carries user_version across', async () => {
    const source = createTestDb();
    await source.execAsync('CREATE TABLE a (id TEXT PRIMARY KEY)');
    await source.runAsync('PRAGMA user_version = 4');
    const dest = createTestDb();

    await backupTestDb(source, dest);

    expect(await dest.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: 4 });
  });

  it('leaves the destination untouched when the copy fails part-way', async () => {
    const source = await childFirstSource();
    const dest = await createMigratedTestDb();
    await dest.runAsync(
      `INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('existing', 'u1', '', '')`,
    );
    const realRunAsync = dest.runAsync.getMockImplementation()!;
    dest.runAsync.mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (String(sql).startsWith('INSERT INTO')) throw new Error('disk full');
      return realRunAsync(sql, ...params);
    });

    await expect(backupTestDb(source, dest)).rejects.toThrow('disk full');

    dest.runAsync.mockImplementation(realRunAsync);
    // Rolled back: the pre-existing row and schema survive rather than being
    // left half-replaced by the source's.
    expect(await dest.getAllAsync('SELECT id FROM notes')).toEqual([{ id: 'existing' }]);
  });
});

describe('database handle lifecycle', () => {
  it('hands out a fresh, migrated, empty database to every test', async () => {
    await globalThis.testDb.runAsync(
      `INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('leaked', 'u1', '', '')`,
    );
    expect(await globalThis.testDb.getAllAsync('SELECT id FROM notes')).toEqual([{ id: 'leaked' }]);
  });

  it('does not leak the previous test rows', async () => {
    expect(await globalThis.testDb.getAllAsync('SELECT id FROM notes')).toEqual([]);
  });

  it('tolerates a test closing its own database', async () => {
    // The next test's reset must not double-close this handle, which would throw.
    const db = createTestDb();
    await db.closeAsync();

    expect(db.closeAsync).toHaveBeenCalled();
  });

  it('still starts cleanly after a test closed a database itself', async () => {
    expect(await globalThis.testDb.getAllAsync('SELECT id FROM notes')).toEqual([]);
  });
});
