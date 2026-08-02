/**
 * A real SQLite engine for tests, standing in for `expo-sqlite`.
 *
 * Node ships SQLite in its standard library (`node:sqlite`), and `mobile/`
 * already requires Node >= 24, so the whole `src/db/` layer can run its SQL for
 * real in Jest instead of against canned `jest.fn()` return values. Everything
 * here is a thin translation between the two APIs — `node:sqlite` is
 * synchronous and names a few things differently — plus faithful copies of the
 * expo-side behaviours that `src/db/` depends on (param normalization,
 * `null` for a missing first row, BEGIN/COMMIT/ROLLBACK).
 *
 * Each method is a `jest.fn()` wrapping the real execution, so a suite can
 * still spy on call order or arguments while the SQL actually runs.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
// Safe to import statically even though `jest.setup.js` loads this module from
// inside the `expo-sqlite` mock factory: `src/db/schema` only imports a *type*
// from expo-sqlite, so there is no runtime cycle.
import { migrateDatabase } from '../../src/db/schema';

export type TestDatabase = SQLiteDatabase & {
  execAsync: jest.Mock;
  runAsync: jest.Mock;
  getAllAsync: jest.Mock;
  getFirstAsync: jest.Mock;
  withTransactionAsync: jest.Mock;
  closeAsync: jest.Mock;
};

/**
 * Coerce one bind value the way expo-sqlite's native layer does: booleans
 * become 1/0 and `undefined` becomes NULL. `node:sqlite` rejects both outright,
 * so without this a call that works on device would throw here.
 */
function toBindValue(value: unknown): SQLInputValue {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return (value ?? null) as SQLInputValue;
}

/**
 * Mirrors expo-sqlite's `normalizeParams` (`build/paramUtils.js`). Callers pass
 * bind values variadically (`run(sql, a, b)`), as one array (`run(sql, [a, b])`),
 * or as a named-param object — all three have to reach `node:sqlite` correctly.
 */
function normalizeParams(params: unknown[]): SQLInputValue[] {
  let bind: unknown = params.length > 1 ? params : params[0];
  if (bind == null) {
    bind = [];
  }
  if (typeof bind !== 'object' || bind instanceof ArrayBuffer || ArrayBuffer.isView(bind)) {
    bind = [bind];
  }
  if (Array.isArray(bind)) {
    return bind.map(toBindValue);
  }
  const named: Record<string, SQLInputValue> = {};
  const entries = Object.entries(bind as Record<string, unknown>);
  for (const entry of entries) {
    named[entry[0]] = toBindValue(entry[1]);
  }
  // node:sqlite takes named params as the first argument, on an overload that a
  // spread cannot select alongside the positional one — hence the cast. Runtime
  // behaviour is identical; only the static signature needs the nudge.
  return [named] as unknown as SQLInputValue[];
}

/**
 * `node:sqlite` returns null-prototype row objects. Copy them to plain objects
 * so `toStrictEqual` and object spreads behave the way callers expect.
 */
function plainRow<T>(row: unknown): T {
  return Object.assign({}, row) as T;
}

/** Every database handed out since the last reset, keyed by name. */
const openDatabases = new Map<string, TestDatabase>();

/**
 * Open a fresh in-memory database. The schema is *not* applied — callers that
 * want the current schema use `createMigratedTestDb()`, and migration tests
 * start here deliberately.
 */
export function createTestDb(): TestDatabase {
  const raw = new DatabaseSync(':memory:');

  const db = {
    execAsync: jest.fn(async (source: string): Promise<void> => {
      raw.exec(source);
    }),

    runAsync: jest.fn(async (source: string, ...params: unknown[]) => {
      const result = raw.prepare(source).run(...normalizeParams(params));
      return {
        lastInsertRowId: Number(result.lastInsertRowid),
        changes: Number(result.changes),
      };
    }),

    getAllAsync: jest.fn(async (source: string, ...params: unknown[]) =>
      raw.prepare(source).all(...normalizeParams(params)).map(plainRow),
    ),

    getFirstAsync: jest.fn(async (source: string, ...params: unknown[]) => {
      const row = raw.prepare(source).get(...normalizeParams(params));
      // expo-sqlite resolves to null, not undefined, when there is no row.
      return row === undefined ? null : plainRow(row);
    }),

    // Same shape as expo-sqlite's own implementation, so a task that throws
    // part-way rolls its partial writes back exactly as it would on device.
    withTransactionAsync: jest.fn(async (task: () => Promise<void>): Promise<void> => {
      try {
        await db.execAsync('BEGIN');
        await task();
        await db.execAsync('COMMIT');
      } catch (error) {
        await db.execAsync('ROLLBACK');
        throw error;
      }
    }),

    closeAsync: jest.fn(async (): Promise<void> => {
      raw.close();
    }),
  };

  return db as unknown as TestDatabase;
}

/** Open a fresh in-memory database with every migration in `src/db/schema` applied. */
export async function createMigratedTestDb(): Promise<TestDatabase> {
  const db = createTestDb();
  await migrateDatabase(db);
  return db;
}

/**
 * The database the mocked `useSQLiteContext()` / `SQLiteProvider` hand out.
 * Replaced with a fresh migrated one before every test.
 */
let defaultDb: TestDatabase | null = null;

export function getDefaultTestDb(): TestDatabase {
  if (!defaultDb) {
    throw new Error('Test database is not ready — resetTestDatabases() runs in a global beforeEach.');
  }
  return defaultDb;
}

/** Backs the mocked `openDatabaseAsync`: same name in one test means the same database. */
export function openNamedTestDb(name: string): TestDatabase {
  const existing = openDatabases.get(name);
  if (existing) {
    return existing;
  }
  const db = createTestDb();
  openDatabases.set(name, db);
  return db;
}

/**
 * Copy a whole database into another, standing in for expo-sqlite's
 * `backupDatabaseAsync`. Schema, rows, and `user_version` all move, so the
 * legacy-database migration path in `src/db/serverDatabase.ts` can be checked
 * on its results rather than on the fact that a mock was called.
 */
export async function backupTestDb(source: TestDatabase, dest: TestDatabase): Promise<void> {
  const destTables = await dest.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const table of destTables) {
    await dest.execAsync(`DROP TABLE IF EXISTS "${table.name}"`);
  }

  const objects = await source.getAllAsync<{ type: string; name: string; sql: string }>(
    `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
  );
  for (const object of objects) {
    await dest.execAsync(object.sql);
  }

  for (const object of objects) {
    if (object.type !== 'table') {
      continue;
    }
    const rows = await source.getAllAsync<Record<string, unknown>>(`SELECT * FROM "${object.name}"`);
    for (const row of rows) {
      const columns = Object.keys(row);
      await dest.runAsync(
        `INSERT INTO "${object.name}" (${columns.map((c) => `"${c}"`).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => row[c] as never),
      );
    }
  }

  const version = await source.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  await dest.runAsync(`PRAGMA user_version = ${version?.user_version ?? 0}`);
}

/**
 * Discard every database from the previous test and install a fresh migrated
 * default. Called from a global `beforeEach`, so no suite has to opt in and no
 * state leaks between tests.
 */
export async function resetTestDatabases(): Promise<void> {
  openDatabases.clear();
  defaultDb = await createMigratedTestDb();
}
