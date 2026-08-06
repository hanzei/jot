import type { SQLiteDatabase } from 'expo-sqlite';

// Per-db chain so each connection serializes its own writes independently.
const writeChains = new WeakMap<SQLiteDatabase, Promise<void>>();

// Serialize writes per db connection — SQLite only allows one active transaction at a time.
export function withSerializedTransaction(
  db: SQLiteDatabase,
  task: () => Promise<void>,
): Promise<void> {
  const current = writeChains.get(db) ?? Promise.resolve();
  const next = current.then(() => db.withTransactionAsync(task));
  // Swallow the rejection on the shared chain so one failed write doesn't block
  // all subsequent transactions from running.
  writeChains.set(db, next.catch(() => {}));
  return next;
}
