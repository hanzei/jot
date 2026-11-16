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

const stepsByNote = new Map<string, Map<number, number>>();

/** Record that this device's edit to `noteId`, sent at `from`, produced `to`. */
export function recordOwnVersionStep(noteId: string, from: number, to: number): void {
  if (from === to) return;
  let steps = stepsByNote.get(noteId);
  if (!steps) {
    steps = new Map();
    stepsByNote.set(noteId, steps);
  }
  // A step out of `to` can only predate this one when the note's versions
  // restarted (a duplicate's server copy starts afresh below its source's): it
  // belongs to the old numbering, and following it would loop back past `to`.
  steps.delete(to);
  steps.set(from, to);
}

/**
 * The version to send for an edit based on `base`: `base` advanced through
 * every version this device's own landed edits produced from it.
 */
export function resolveOwnBaseVersion(noteId: string, base: number): number {
  const steps = stepsByNote.get(noteId);
  if (!steps) return base;
  let version = base;
  const seen = new Set<number>();
  for (let next = steps.get(version); next !== undefined && !seen.has(version); next = steps.get(version)) {
    seen.add(version);
    version = next;
  }
  return version;
}

/** Forget every recorded step. For a local-data wipe, and tests. */
export function clearOwnVersionSteps(): void {
  stepsByNote.clear();
}
