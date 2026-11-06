import { createCompletedWriteTracker } from '@jot/shared';

/**
 * The completed-write gate (see completedWrites in @jot/shared) for every server
 * item snapshot written to SQLite. Item ids are globally unique, so one tracker
 * serves every note; the note editor keeps its own for its in-memory state.
 */
export const localCompletedWrites = createCompletedWriteTracker();
