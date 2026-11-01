import { createCompletedWriteTracker } from '@jot/shared';

/**
 * The completed-write gate for the local SQLite rows (see completedWrites in
 * @jot/shared). The note editor keeps its own for its in-memory state; this one
 * covers every write of a server item snapshot into SQLite — the item-action
 * hooks in useNotes, the queue drain, and server note saves (SSE, background
 * sync) — so none of them can put back a completed flag that a write still in
 * flight, or a newer response, has changed. Item ids are globally unique, so one
 * tracker serves every note.
 */
export const localCompletedWrites = createCompletedWriteTracker();
