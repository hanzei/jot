/**
 * Tests for isClosedDatabaseError (db/errors): the guard that lets background
 * sync and the queue drain distinguish "the SQLiteProvider was torn down and
 * closed the handle underneath us" from a retryable failure (issue #971).
 */

import { isClosedDatabaseError } from '../src/db/errors';

describe('isClosedDatabaseError', () => {
  it('matches expo-sqlite closed-resource rejections in the message', () => {
    // The shape logged on device: the CodedError folds the reason into its message.
    const err = new Error(
      "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: Access to closed resource",
    );
    expect(isClosedDatabaseError(err)).toBe(true);
  });

  it('matches when the marker only appears in a nested cause', () => {
    const cause = new Error('Access to closed resource');
    const err = new Error('wrapper', { cause });
    expect(isClosedDatabaseError(err)).toBe(true);
  });

  it('matches a bare string', () => {
    expect(isClosedDatabaseError('Access to closed resource')).toBe(true);
  });

  it('does not match unrelated errors or non-errors', () => {
    expect(isClosedDatabaseError(new Error('Network Error'))).toBe(false);
    expect(isClosedDatabaseError(new Error('NOT NULL constraint failed: users.created_at'))).toBe(false);
    expect(isClosedDatabaseError(undefined)).toBe(false);
    expect(isClosedDatabaseError(null)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const err = new Error('boom') as Error & { cause?: unknown };
    err.cause = err;
    expect(isClosedDatabaseError(err)).toBe(false);
  });
});
