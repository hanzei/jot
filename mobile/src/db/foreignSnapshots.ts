// Notes an SSE payload from another device may have rolled back (#1273, spec §8.3).
//
// A payload is built on the server when the change happens, but the snapshot
// gate can only mark it on receipt. So a collaborator's payload built just
// before one of this device's writes landed, and received after it, passes the
// gate and saves the older state over the newer one. This device's own
// `note_updated` echo is built after its write and, on the same stream, arrives
// after that payload. useSSE uses it as the cue to fetch the note again: the
// fetch is marked after the landing, so the gate makes it correct.
//
// A note is flagged when a foreign payload was saved to it after one of this
// device's writes on it had landed, and stays flagged until the echo's fetch is
// sent. A later landing does not clear it: many landings (a share, a response
// held back for queued ops) never overwrite the row. A stale flag costs one GET.
// Kept in memory per database, like ownVersions.ts: note ids are only unique
// within one server's data.

import type { SQLiteDatabase } from 'expo-sqlite';
import { hasWriteLanded } from './snapshotGate';

const flaggedByDb = new WeakMap<SQLiteDatabase, Set<string>>();

/** Record that a payload from another device was saved to `noteId`. */
export function recordForeignSnapshotSaved(db: SQLiteDatabase, noteId: string): void {
  // Nothing of ours has landed on the note, so there is nothing to roll back.
  if (!hasWriteLanded(noteId)) return;
  let flagged = flaggedByDb.get(db);
  if (!flagged) {
    flagged = new Set();
    flaggedByDb.set(db, flagged);
  }
  flagged.add(noteId);
}

/** Whether `noteId` needs a fetch to undo a possible rollback. Clears the flag. */
export function takeForeignSnapshotFlag(db: SQLiteDatabase, noteId: string): boolean {
  return flaggedByDb.get(db)?.delete(noteId) ?? false;
}

/** Forget every flag recorded for `db`, whose local data was wiped. */
export function clearForeignSnapshotFlags(db: SQLiteDatabase): void {
  flaggedByDb.delete(db);
}
