/**
 * Tests for the local-mode short-circuits that make local writes terminal
 * (issue #514): when local mode is active, `enqueueOperation` must not append
 * anything to `sync_queue`, and `markNotePendingCreate` must leave the note at
 * its terminal 'synced' state instead of flagging it pending a server confirm.
 */

import { enqueueOperation, subscribeToEnqueue } from '../src/db/syncQueue';
import { markNotePendingCreate } from '../src/db/noteQueries';
import { setLocalModeActive, isLocalModeActive } from '../src/store/localMode';

function makeDb() {
  return {
    runAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    getAllAsync: jest.fn().mockResolvedValue([]),
  };
}

describe('local-mode terminal writes', () => {
  afterEach(() => {
    // Never leak the flag into other suites — default is the online sync engine.
    setLocalModeActive(false);
  });

  describe('enqueueOperation', () => {
    it('appends to sync_queue and notifies listeners when local mode is off', async () => {
      setLocalModeActive(false);
      const db = makeDb();
      const listener = jest.fn();
      const unsubscribe = subscribeToEnqueue(listener);

      await enqueueOperation(db as never, {
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: { id: 'n1' },
      });

      expect(db.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sync_queue'),
        expect.arrayContaining(['create', '/notes', 'POST']),
      );
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('short-circuits without touching sync_queue or notifying when local mode is on', async () => {
      setLocalModeActive(true);
      const db = makeDb();
      const listener = jest.fn();
      const unsubscribe = subscribeToEnqueue(listener);

      await enqueueOperation(db as never, {
        operation: 'update',
        endpoint: '/notes/n1',
        method: 'PATCH',
        body: { title: 'x' },
      });

      expect(db.runAsync).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  describe('markNotePendingCreate', () => {
    it("flags the note 'pending' when local mode is off", async () => {
      setLocalModeActive(false);
      const db = makeDb();

      await markNotePendingCreate(db as never, 'n1');

      expect(db.runAsync).toHaveBeenCalledWith(
        `UPDATE notes SET sync_state = 'pending' WHERE id = ?`,
        ['n1'],
      );
    });

    it("leaves the note terminal ('synced') when local mode is on", async () => {
      setLocalModeActive(true);
      const db = makeDb();

      await markNotePendingCreate(db as never, 'n1');

      expect(db.runAsync).not.toHaveBeenCalled();
    });
  });

  describe('isLocalModeActive', () => {
    it('tracks the value set by setLocalModeActive', () => {
      setLocalModeActive(true);
      expect(isLocalModeActive()).toBe(true);
      setLocalModeActive(false);
      expect(isLocalModeActive()).toBe(false);
    });
  });
});
