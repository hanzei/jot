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
import { makeLabel, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

const label = (id: string, name: string): Label => makeLabel({ id, name, created_at: 'c', updated_at: 'u' });

const storedLabelIds = async (): Promise<string[]> => {
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM labels ORDER BY id');
  return rows.map((r) => r.id);
};

describe('getStoredLabels', () => {
  it('reads labels from the store sorted by name', async () => {
    await upsertLabel(db, label('l2', 'Work'));
    await upsertLabel(db, label('l1', 'Alpha'));

    const labels = await getStoredLabels(db);

    expect(labels.map((l) => l.name)).toEqual(['Alpha', 'Work']);
  });

  it('returns an empty list when the store is empty', async () => {
    expect(await getStoredLabels(db)).toEqual([]);
  });
});

describe('upsertLabel', () => {
  it('inserts a label that is not yet stored', async () => {
    await upsertLabel(db, label('l1', 'Work'));

    expect(await getStoredLabels(db)).toEqual([label('l1', 'Work')]);
  });

  it('updates in place on a repeated id rather than failing the primary key', async () => {
    await upsertLabel(db, label('l1', 'Work'));

    await upsertLabel(db, { ...label('l1', 'Renamed'), updated_at: 'u2' });

    // ON CONFLICT(id) DO UPDATE — inert against a mock, enforced here.
    expect(await getStoredLabels(db)).toEqual([{ ...label('l1', 'Renamed'), updated_at: 'u2' }]);
  });
});

describe('renameStoredLabel', () => {
  it('updates the label name', async () => {
    await upsertLabel(db, label('l1', 'Work'));

    await renameStoredLabel(db, 'l1', 'Renamed');

    const stored = (await getStoredLabels(db))[0]!;
    expect(stored.name).toBe('Renamed');
    expect(stored.updated_at).not.toBe('u');
  });

  it('leaves other labels alone', async () => {
    await upsertLabel(db, label('l1', 'Work'));
    await upsertLabel(db, label('l2', 'Home'));

    await renameStoredLabel(db, 'l1', 'Renamed');

    expect((await getStoredLabels(db)).map((l) => l.name)).toEqual(['Home', 'Renamed']);
  });
});

describe('deleteStoredLabel', () => {
  it('deletes the label by id', async () => {
    await upsertLabel(db, label('l1', 'Work'));
    await upsertLabel(db, label('l2', 'Home'));

    await deleteStoredLabel(db, 'l1');

    expect(await storedLabelIds()).toEqual(['l2']);
  });
});

describe('saveLabels', () => {
  it('upserts server labels and prunes local labels the server no longer has', async () => {
    await upsertLabel(db, label('l1', 'Work'));
    await upsertLabel(db, label('stale', 'Stale'));

    await saveLabels(db, [label('l1', 'Work'), label('l2', 'Home')]);

    expect(await storedLabelIds()).toEqual(['l1', 'l2']);
  });

  it('neither prunes nor upserts a label readSkipLabelIds protects', async () => {
    await upsertLabel(db, label('pending-local', 'Offline'));
    await upsertLabel(db, label('renamed', 'New name'));

    await saveLabels(db, [label('renamed', 'Old name')], {
      readSkipLabelIds: async () => new Set(['pending-local', 'renamed']),
    });

    expect(await getStoredLabels(db)).toEqual([
      expect.objectContaining({ id: 'renamed', name: 'New name' }),
      expect.objectContaining({ id: 'pending-local', name: 'Offline' }),
    ]);
  });
});

describe('getPendingLabelIds', () => {
  it('collects the ids of queued createLabel, renameLabel and deleteLabel ops', async () => {
    await seedQueueEntry(db, {
      operation: 'renameLabel', endpoint: '/labels/r', method: 'PATCH', body: { name: 'R' }, keys: ['label:r'],
    });
    await seedQueueEntry(db, { operation: 'deleteLabel', endpoint: '/labels/d', method: 'DELETE', keys: ['label:d'] });
    // Attaching a label to a note does not change the label itself.
    await seedQueueEntry(db, {
      operation: 'addLabelToNote', endpoint: '/notes/n1/labels', method: 'POST', body: { name: 'X' }, keys: ['note:n1', 'label:x'],
    });

    expect(await getPendingLabelIds(db)).toEqual(new Set(['r', 'd']));
  });

  it('collects the ids of queued createLabel ops', async () => {
    await seedQueueEntry(db, {
      operation: 'createLabel', endpoint: '/labels', method: 'POST', body: { id: 'a', name: 'A' },
    });
    await seedQueueEntry(db, {
      operation: 'createLabel', endpoint: '/labels', method: 'POST', body: { id: 'b', name: 'B' },
    });
    // A malformed body is tolerated and contributes nothing.
    await db.runAsync(
      `INSERT INTO sync_queue (operation, endpoint, method, body, created_at)
       VALUES ('createLabel', '/labels', 'POST', 'malformed', '2026-01-01T00:00:00Z')`,
    );
    // A non-label op is ignored.
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/n1', method: 'PATCH', body: {} });

    expect(await getPendingLabelIds(db)).toEqual(new Set(['a', 'b']));
  });

  it('is empty when nothing is queued', async () => {
    expect(await getPendingLabelIds(db)).toEqual(new Set());
  });
});

describe('saveServerLabels', () => {
  it('reconciles the store while protecting unsynced offline-created labels', async () => {
    await upsertLabel(db, label('offline-1', 'Offline'));
    await upsertLabel(db, label('gone', 'Gone'));
    await seedQueueEntry(db, {
      operation: 'createLabel',
      endpoint: '/labels',
      method: 'POST',
      body: { id: 'offline-1', name: 'Offline' },
    });

    await saveServerLabels(db, [label('srv-1', 'Server')]);

    // 'gone' pruned; 'offline-1' protected (its create hasn't drained yet).
    expect(await storedLabelIds()).toEqual(['offline-1', 'srv-1']);
  });

  it('keeps a queued rename and does not bring back a label whose delete is queued', async () => {
    await upsertLabel(db, label('renamed', 'New name'));
    await seedQueueEntry(db, {
      operation: 'renameLabel', endpoint: '/labels/renamed', method: 'PATCH', body: { name: 'New name' }, keys: ['label:renamed'],
    });
    await seedQueueEntry(db, { operation: 'deleteLabel', endpoint: '/labels/deleted', method: 'DELETE', keys: ['label:deleted'] });

    // The list predates both ops.
    await saveServerLabels(db, [label('renamed', 'Old name'), label('deleted', 'Deleted')]);

    expect(await getStoredLabels(db)).toEqual([expect.objectContaining({ id: 'renamed', name: 'New name' })]);
  });
});
