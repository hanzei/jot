/**
 * Tests for the local-mode short-circuits that make local writes terminal
 * (issue #514): when local mode is active, `enqueueOperation` must not append
 * anything to `sync_queue`, and `markNotePendingCreate` must leave the note at
 * its terminal 'synced' state instead of flagging it pending a server confirm.
 */

import { enqueueOperation, subscribeToEnqueue } from '../src/db/syncQueue';
import { markNotePendingCreate, saveNote } from '../src/db/noteQueries';
import { setLocalModeActive, isLocalModeActive } from '../src/store/localMode';
import { makeTextNote } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

describe('local-mode terminal writes', () => {
  afterEach(() => {
    // Never leak the flag into other suites — default is the online sync engine.
    setLocalModeActive(false);
  });

  describe('enqueueOperation', () => {
    it('appends to sync_queue and notifies listeners when local mode is off', async () => {
      setLocalModeActive(false);
      const listener = jest.fn();
      const unsubscribe = subscribeToEnqueue(listener);

      await enqueueOperation(db, {
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: { id: 'n1' },
      });

      expect(await db.getAllAsync('SELECT operation, endpoint, method, body FROM sync_queue')).toEqual([
        { operation: 'create', endpoint: '/notes', method: 'POST', body: '{"id":"n1"}' },
      ]);
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('short-circuits without touching sync_queue or notifying when local mode is on', async () => {
      setLocalModeActive(true);
      const listener = jest.fn();
      const unsubscribe = subscribeToEnqueue(listener);

      await enqueueOperation(db, {
        operation: 'update',
        endpoint: '/notes/n1',
        method: 'PATCH',
        body: { title: 'x' },
      });

      expect(await db.getAllAsync('SELECT * FROM sync_queue')).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  describe('markNotePendingCreate', () => {
    beforeEach(async () => {
      await saveNote(db, makeTextNote({ id: 'n1' }));
    });

    const syncStateOf = async (id: string): Promise<string | undefined> => {
      const row = await db.getFirstAsync<{ sync_state: string }>(
        'SELECT sync_state FROM notes WHERE id = ?',
        [id],
      );
      return row?.sync_state;
    };

    it("flags the note 'pending' when local mode is off", async () => {
      setLocalModeActive(false);

      await markNotePendingCreate(db, 'n1');

      expect(await syncStateOf('n1')).toBe('pending');
    });

    it("leaves the note terminal ('synced') when local mode is on", async () => {
      setLocalModeActive(true);

      await markNotePendingCreate(db, 'n1');

      expect(await syncStateOf('n1')).toBe('synced');
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
