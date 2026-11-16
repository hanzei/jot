// The versions this device's own content edits produced, per note (spec §8.2,
// #1284). A content edit is queued with the version the editor was showing as
// its `base_version`, and the editor keeps that baseline while it is dirty. Once
// the drain lands the edit, the note is at a version the editor never saw, but
// it holds nothing beyond the editor's own text: the server accepted the edit
// at exactly that base. The next save from the same editor must therefore be
// sent against the new version, or it would conflict with itself.
//
// Queued rows are rebased in the drain's landing transaction (see
// rebaseQueuedEdits in syncQueue.ts), which survives a restart. This ledger
// covers the edit enqueued after that transaction, from an editor whose
// baseline predates it. It lives in memory: an editor's baseline does not
// outlive the process either, since a fresh editor hydrates from the row.

import type { SQLiteDatabase } from 'expo-sqlite';

// Kept per database: each server has its own, and note ids are only unique
// within one server's data (a backup restored onto a second server shares them).
const stepsByDb = new WeakMap<SQLiteDatabase, Map<string, Map<number, number>>>();

/** Record that this device's edit to `noteId`, sent at `from`, produced `to`. */
export function recordOwnVersionStep(db: SQLiteDatabase, noteId: string, from: number, to: number): void {
  if (from === to) return;
  let byNote = stepsByDb.get(db);
  if (!byNote) {
    byNote = new Map();
    stepsByDb.set(db, byNote);
  }
  let steps = byNote.get(noteId);
  if (!steps) {
    steps = new Map();
    byNote.set(noteId, steps);
  }
  steps.set(from, to);
}

/**
 * The version to send for an edit based on `base`: `base` advanced through
 * every version this device's own landed edits produced from it. A step only
 * ever moves up (the server accepts an edit at `from` as `from + 1`), so the
 * walk ends.
 */
export function resolveOwnBaseVersion(db: SQLiteDatabase, noteId: string, base: number): number {
  const steps = stepsByDb.get(db)?.get(noteId);
  let version = base;
  for (let next = steps?.get(version); next !== undefined; next = steps?.get(version)) version = next;
  return version;
}

/** Forget every step recorded for `db`, whose local data was wiped. */
export function clearOwnVersionSteps(db: SQLiteDatabase): void {
  stepsByDb.delete(db);
}
