/**
 * Tests for the canonical local label store (issue #691): the `labels`-table
 * query helpers in db/noteQueries and the sync-queue reconciliation wrappers.
 */

import {
  getStoredLabels,
  upsertLabel,
  renameStoredLabel,
  deleteStoredLabel,
  saveLabels,
} from '../src/db/noteQueries';
import { getPendingLabelIds, saveServerLabels } from '../src/db/syncQueue';
import type { Label } from '@jot/shared';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

type MockDb = {
  execAsync: jest.Mock;
  runAsync: jest.Mock;
  getFirstAsync: jest.Mock;
  getAllAsync: jest.Mock;
  withTransactionAsync: jest.Mock;
};

function makeDb(overrides: Partial<MockDb> = {}): MockDb {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockResolvedValue({}),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    getAllAsync: jest.fn().mockResolvedValue([]),
    // Run the transaction body immediately (real SQLite serializes; the mock
    // just invokes the callback so the enclosed writes are observable).
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => { await task(); }),
    ...overrides,
  };
}

const label = (id: string, name: string): Label => ({
  id, user_id: 'u1', name, created_at: 'c', updated_at: 'u',
});

const runSqls = (db: MockDb): string[] =>
  (db.runAsync.mock.calls as unknown[][]).map((c) => c[0] as string);

describe('getStoredLabels', () => {
  it('reads labels from the store sorted by name', async () => {
    const db = makeDb({
      getAllAsync: jest.fn().mockResolvedValue([
        { id: 'l2', user_id: 'u1', name: 'Work', created_at: 'c', updated_at: 'u' },
        { id: 'l1', user_id: 'u1', name: 'Alpha', created_at: 'c', updated_at: 'u' },
      ]),
    });

    const labels = await getStoredLabels(db as never);

    expect(db.getAllAsync).toHaveBeenCalledWith('SELECT * FROM labels');
    expect(labels.map((l) => l.name)).toEqual(['Alpha', 'Work']);
  });
});

describe('upsertLabel', () => {
  it('inserts or updates a single label by id', async () => {
    const db = makeDb();

    await upsertLabel(db as never, label('l1', 'Work'));

    expect(db.runAsync).toHaveBeenCalledTimes(1);
    const [sql, args] = db.runAsync.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO labels');
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(args).toEqual(['l1', 'u1', 'Work', 'c', 'u']);
  });
});

describe('renameStoredLabel', () => {
  it('updates the label name', async () => {
    const db = makeDb();

    await renameStoredLabel(db as never, 'l1', 'Renamed');

    const [sql, args] = db.runAsync.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe('UPDATE labels SET name = ?, updated_at = ? WHERE id = ?');
    expect(args[0]).toBe('Renamed');
    expect(args[2]).toBe('l1');
  });
});

describe('deleteStoredLabel', () => {
  it('deletes the label by id', async () => {
    const db = makeDb();

    await deleteStoredLabel(db as never, 'l1');

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM labels WHERE id = ?', ['l1']);
  });
});

describe('saveLabels', () => {
  it('upserts server labels and prunes local labels the server no longer has', async () => {
    const db = makeDb({
      getAllAsync: jest.fn().mockResolvedValue([{ id: 'l1' }, { id: 'stale' }]),
    });

    await saveLabels(db as never, [label('l1', 'Work'), label('l2', 'Home')]);

    // 'stale' is pruned; 'l1' and 'l2' are upserted.
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM labels WHERE id = ?', ['stale']);
    expect(runSqls(db).filter((s) => s.startsWith('INSERT INTO labels'))).toHaveLength(2);
    // A server-present label is never pruned.
    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM labels WHERE id = ?', ['l1']);
  });

  it('does not prune a label protected by skipLabelIds (unsynced offline create)', async () => {
    const db = makeDb({
      getAllAsync: jest.fn().mockResolvedValue([{ id: 'pending-local' }]),
    });

    await saveLabels(db as never, [], { skipLabelIds: new Set(['pending-local']) });

    expect(db.runAsync).not.toHaveBeenCalledWith(
      'DELETE FROM labels WHERE id = ?', ['pending-local'],
    );
  });
});

describe('getPendingLabelIds', () => {
  it('collects the ids of queued createLabel ops', async () => {
    const db = makeDb({
      getAllAsync: jest.fn().mockResolvedValue([
        { operation: 'createLabel', body: JSON.stringify({ id: 'a', name: 'A' }) },
        { operation: 'createLabel', body: JSON.stringify({ id: 'b', name: 'B' }) },
        { operation: 'createLabel', body: 'malformed' },
      ]),
    });

    const ids = await getPendingLabelIds(db as never);

    expect(ids).toEqual(new Set(['a', 'b']));
  });
});

describe('saveServerLabels', () => {
  it('reconciles the store while protecting unsynced offline-created labels', async () => {
    // First getAllAsync: the queued createLabel scan (getPendingLabelIds).
    // Second getAllAsync: the existing-rows scan inside saveLabels.
    const db = makeDb({
      getAllAsync: jest.fn()
        .mockResolvedValueOnce([{ operation: 'createLabel', body: JSON.stringify({ id: 'offline-1', name: 'Offline' }) }])
        .mockResolvedValueOnce([{ id: 'offline-1' }, { id: 'gone' }]),
    });

    await saveServerLabels(db as never, [label('srv-1', 'Server')]);

    // 'gone' pruned; 'offline-1' protected (its create hasn't drained yet).
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM labels WHERE id = ?', ['gone']);
    expect(db.runAsync).not.toHaveBeenCalledWith('DELETE FROM labels WHERE id = ?', ['offline-1']);
  });
});
