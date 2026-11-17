/**
 * Merging queued ops that supersede each other at enqueue (spec §8.5, #1268).
 * Runs against the real SQLite adapter: asserts on the resulting queue rows and
 * on what `drainQueue` sends.
 */

import { saveNote } from '../src/db/noteQueries';
import { drainQueue, enqueueOperation, type EnqueueParams } from '../src/db/syncQueue';
import api from '../src/api/client';
import { makeListNote, makeTextNote, queuedOps, seedQueueEntry } from './helpers/fixtures';
import { silenceConsole } from './helpers/consoleGuard';
import type { TestDatabase } from './helpers/testDb';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;
const NOTE_ID = 'MergeNote0000000000000';
const OTHER_ID = 'MergeOther000000000000';

let db: TestDatabase;
beforeEach(async () => {
  jest.clearAllMocks();
  // Unconsumed one-off responses must not leak into the next test.
  mockApi.patch.mockReset();
  mockApi.post.mockReset();
  db = globalThis.testDb;
  // The drain pulls touched notes it could not settle; nothing here cares.
  mockApi.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true,
    response: { status: 404 },
  }));
  silenceConsole('warn', /^Failed to pull note id=/);
  await saveNote(db, makeTextNote({ id: NOTE_ID, content: 'Old', version: 5 }));
  await saveNote(db, makeTextNote({ id: OTHER_ID, content: 'Other', version: 2 }));
});

function update(body: Record<string, unknown>, noteId = NOTE_ID): EnqueueParams {
  return { operation: 'update', endpoint: `/notes/${noteId}`, method: 'PATCH', keys: [`note:${noteId}`], body };
}

function updateItem(itemId: string, body: Record<string, unknown>): EnqueueParams {
  return {
    operation: 'updateItem',
    endpoint: `/notes/${NOTE_ID}/items/${itemId}`,
    method: 'PATCH',
    keys: [`note:${NOTE_ID}`],
    body,
  };
}

function setCompleted(itemIds: string[], completed: boolean): EnqueueParams {
  return {
    operation: 'setItemsCompleted',
    endpoint: `/notes/${NOTE_ID}/items/set-completed`,
    method: 'POST',
    keys: [`note:${NOTE_ID}`],
    body: { item_ids: itemIds, completed },
  };
}

function reorder(noteIds: string[]): EnqueueParams {
  return { operation: 'reorder', endpoint: '/notes/reorder', method: 'POST', keys: noteIds.map((id) => `note:${id}` as const), body: { note_ids: noteIds } };
}

function createText(noteId: string, body: Record<string, unknown> = {}): EnqueueParams {
  return {
    operation: 'create',
    endpoint: '/notes',
    method: 'POST',
    keys: [`note:${noteId}`],
    body: { id: noteId, note_type: 'text', content: 'First', ...body },
  };
}

async function enqueueAll(...ops: EnqueueParams[]): Promise<void> {
  for (const op of ops) await enqueueOperation(db, op);
}

async function rows(): Promise<[string, Record<string, unknown> | null][]> {
  return (await queuedOps(db)).map((op) => [op.operation, op.body]);
}

const ok = (content = 'x', id = NOTE_ID) => ({ data: makeTextNote({ id, content, version: 6 }) }) as never;

describe('content saves', () => {
  it('merges consecutive saves into one row that keeps the first base_version', async () => {
    await enqueueAll(
      update({ content: 'A', base_version: 5 }),
      update({ content: 'AB', base_version: 5 }),
      update({ content: 'ABC', base_version: 6 }),
    );

    expect(await rows()).toEqual([['update', { content: 'ABC', base_version: 5 }]]);
  });

  it('sends the merged row as one PATCH', async () => {
    await enqueueAll(update({ content: 'A', base_version: 5 }), update({ content: 'AB', base_version: 5 }));
    mockApi.patch.mockResolvedValueOnce(ok('AB'));

    await drainQueue(db);

    expect(mockApi.patch.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [`/notes/${NOTE_ID}`, { content: 'AB', base_version: 5 }],
    ]);
  });

  it('keeps content and per-user fields in separate rows', async () => {
    await enqueueAll(
      update({ content: 'A', base_version: 5 }),
      update({ pinned: true }),
      update({ content: 'AB', base_version: 5 }),
    );

    // Only the last op for the note is a merge target, so the order holds.
    expect(await rows()).toEqual([
      ['update', { content: 'A', base_version: 5 }],
      ['update', { pinned: true }],
      ['update', { content: 'AB', base_version: 5 }],
    ]);
  });

  it('does not merge a body that mixes content and per-user fields', async () => {
    await enqueueAll(update({ content: 'A', base_version: 5 }), update({ content: 'AB', pinned: true, base_version: 5 }));

    expect(await rows()).toHaveLength(2);
  });

  it('does not merge a save into a row queued without a stored base', async () => {
    await seedQueueEntry(db, update({ content: 'Legacy' }));
    await enqueueAll(update({ content: 'New', base_version: 5 }));

    expect(await rows()).toHaveLength(2);
  });

  it('does not merge saves to different notes', async () => {
    await enqueueAll(update({ content: 'A', base_version: 5 }), update({ content: 'B', base_version: 2 }, OTHER_ID));

    expect(await rows()).toHaveLength(2);
  });

  it('does not merge across a later op on the note', async () => {
    await enqueueAll(update({ content: 'A', base_version: 5 }), {
      operation: 'addLabelToNote',
      endpoint: `/notes/${NOTE_ID}/labels`,
      method: 'POST',
      keys: [`note:${NOTE_ID}`, 'label:L1'],
      body: { name: 'Errands' },
    }, update({ content: 'AB', base_version: 5 }));

    expect((await rows()).map(([operation]) => operation)).toEqual(['update', 'addLabelToNote', 'update']);
  });

  it('does not move a save ahead of a queued duplicate of the note', async () => {
    await enqueueAll(update({ content: 'A', base_version: 5 }), {
      operation: 'duplicate',
      endpoint: `/notes/${NOTE_ID}/duplicate`,
      method: 'POST',
      keys: ['note:CopyNote00000000000000'],
      readKeys: [`note:${NOTE_ID}`],
      body: { id: 'CopyNote00000000000000' },
    }, update({ content: 'AB', base_version: 5 }));

    expect((await rows()).map(([operation]) => operation)).toEqual(['update', 'duplicate', 'update']);
  });
});

describe('per-user changes', () => {
  it('merges repeated changes, last value wins', async () => {
    await enqueueAll(update({ pinned: true }), update({ color: '#f28b82' }), update({ pinned: false }));

    expect(await rows()).toEqual([['update', { pinned: false, color: '#f28b82' }]]);
  });
});

describe('edits to a note whose create is queued', () => {
  beforeEach(async () => {
    await saveNote(db, makeTextNote({ id: 'NewNote000000000000000', content: 'First', version: 1 }));
  });
  const NEW_ID = 'NewNote000000000000000';

  it('folds content, colour and pin into the create', async () => {
    await enqueueAll(
      createText(NEW_ID),
      update({ content: 'Second', base_version: 1 }, NEW_ID),
      update({ pinned: true, color: '#fbbc04' }, NEW_ID),
      update({ content: 'Final', base_version: 1 }, NEW_ID),
    );

    expect(await rows()).toEqual([
      ['create', { id: NEW_ID, note_type: 'text', content: 'Final', pinned: true, color: '#fbbc04' }],
    ]);
  });

  it('sends one create with the final content', async () => {
    await enqueueAll(createText(NEW_ID), update({ content: 'Final', base_version: 1 }, NEW_ID));
    mockApi.post.mockResolvedValueOnce({ data: makeTextNote({ id: NEW_ID, content: 'Final', version: 1 }) } as never);

    await drainQueue(db);

    expect(mockApi.post.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['/notes', { id: NEW_ID, note_type: 'text', content: 'Final' }],
    ]);
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('folds a list title, past item ops queued behind the create', async () => {
    await saveNote(db, makeListNote({ id: 'NewList000000000000000', title: '', version: 1 }));
    await enqueueAll(
      { operation: 'create', endpoint: '/notes', method: 'POST', keys: ['note:NewList000000000000000'], body: { id: 'NewList000000000000000', note_type: 'list', title: '' } },
      { operation: 'createItem', endpoint: '/notes/NewList000000000000000/items', method: 'POST', keys: ['note:NewList000000000000000'], body: { id: 'I1', text: 'Milk', position: 0 } },
      update({ title: 'Groceries', base_version: 1 }, 'NewList000000000000000'),
    );

    expect(await rows()).toEqual([
      ['create', { id: 'NewList000000000000000', note_type: 'list', title: 'Groceries' }],
      ['createItem', { id: 'I1', text: 'Milk', position: 0 }],
    ]);
  });

  it('queues a field the create does not take as an update', async () => {
    await enqueueAll(createText(NEW_ID), update({ archived: true }, NEW_ID));

    expect(await rows()).toEqual([
      ['create', { id: NEW_ID, note_type: 'text', content: 'First' }],
      ['update', { archived: true }],
    ]);
  });

  it('does not fold over an update queued after the create', async () => {
    // Appended while the create was in flight, which then failed transiently:
    // folding a newer value into the create would let this older one win.
    await enqueueAll(createText(NEW_ID));
    await seedQueueEntry(db, update({ content: 'Second', base_version: 1 }, NEW_ID));
    await enqueueAll(update({ content: 'Third', base_version: 1 }, NEW_ID));

    expect(await rows()).toEqual([
      ['create', { id: NEW_ID, note_type: 'text', content: 'First' }],
      ['update', { content: 'Third', base_version: 1 }],
    ]);
  });

  it('does not fold over a conversion or a duplicate of the note', async () => {
    await enqueueAll(createText(NEW_ID), {
      operation: 'duplicate',
      endpoint: `/notes/${NEW_ID}/duplicate`,
      method: 'POST',
      keys: ['note:CopyNote00000000000000'],
      readKeys: [`note:${NEW_ID}`],
      body: { id: 'CopyNote00000000000000' },
    }, update({ content: 'Later', base_version: 1 }, NEW_ID));

    expect((await rows()).map(([operation]) => operation)).toEqual(['create', 'duplicate', 'update']);
  });
});

describe('item ops', () => {
  it('merges repeated edits of the same item, keeping a re-parent over a null parent_id', async () => {
    await enqueueAll(
      updateItem('I1', { text: 'a', parent_id: 'P1' }),
      updateItem('I1', { text: 'ab', parent_id: null }),
    );

    expect(await rows()).toEqual([['updateItem', { text: 'ab', parent_id: 'P1' }]]);
  });

  it('does not merge edits of different items', async () => {
    await enqueueAll(updateItem('I1', { text: 'a' }), updateItem('I2', { text: 'b' }));

    expect(await rows()).toHaveLength(2);
  });

  it('keeps only the latest check-off of the same items', async () => {
    await enqueueAll(setCompleted(['I1', 'I2'], true), setCompleted(['I2', 'I1'], false));

    expect(await rows()).toEqual([['setItemsCompleted', { item_ids: ['I2', 'I1'], completed: false }]]);
  });

  it('does not merge check-offs of different items', async () => {
    await enqueueAll(setCompleted(['I1'], true), setCompleted(['I2'], true));

    expect(await rows()).toHaveLength(2);
  });

  it('keeps only the latest item reorder', async () => {
    const reorderItems = (ids: string[]): EnqueueParams => ({
      operation: 'reorderItems',
      endpoint: `/notes/${NOTE_ID}/items/reorder`,
      method: 'POST',
      keys: [`note:${NOTE_ID}`],
      body: { item_ids: ids },
    });
    await enqueueAll(reorderItems(['I1', 'I2']), reorderItems(['I2', 'I1']));

    expect(await rows()).toEqual([['reorderItems', { item_ids: ['I2', 'I1'] }]]);
  });
});

describe('note reorders', () => {
  it('keeps only the latest, under the keys of the notes it names', async () => {
    await enqueueAll(reorder([NOTE_ID, OTHER_ID]), reorder([OTHER_ID, NOTE_ID, 'Third000000000000000000']));

    const [op, ...rest] = await queuedOps(db);
    expect(rest).toEqual([]);
    expect(op!.body).toEqual({ note_ids: [OTHER_ID, NOTE_ID, 'Third000000000000000000'] });
    expect(op!.keys).toEqual([`note:${OTHER_ID}`, `note:${NOTE_ID}`, 'note:Third000000000000000000']);
  });

  it('does not replace a reorder with one that leaves out a note it moved', async () => {
    // A reorder from a label view names only that label's notes.
    await enqueueAll(reorder([NOTE_ID, OTHER_ID]), reorder([OTHER_ID]));

    expect(await rows()).toEqual([
      ['reorder', { note_ids: [NOTE_ID, OTHER_ID] }],
      ['reorder', { note_ids: [OTHER_ID] }],
    ]);
  });

  it('does not move a reorder ahead of a create of a note it names', async () => {
    await enqueueAll(reorder([NOTE_ID, OTHER_ID]), createText('Third000000000000000000'), reorder(['Third000000000000000000', NOTE_ID, OTHER_ID]));

    expect((await rows()).map(([operation]) => operation)).toEqual(['reorder', 'create', 'reorder']);
  });
});

describe('opposite pairs', () => {
  it('never merges a share and an unshare', async () => {
    await enqueueAll(
      { operation: 'share', endpoint: `/notes/${NOTE_ID}/shares`, method: 'POST', keys: [`note:${NOTE_ID}`], body: { user_id: 'u2' } },
      { operation: 'unshare', endpoint: `/notes/${NOTE_ID}/shares/u2`, method: 'DELETE', keys: [`note:${NOTE_ID}`] },
    );

    expect((await rows()).map(([operation]) => operation)).toEqual(['share', 'unshare']);
  });
});

describe('merging while the drain runs', () => {
  it('never merges into the row the drain is sending', async () => {
    await enqueueAll(update({ content: 'A', base_version: 5 }));
    // An autosave lands while the request for the queued row is out.
    mockApi.patch
      .mockImplementationOnce((async () => {
        await enqueueAll(update({ content: 'AB', base_version: 5 }));
        return ok('A');
      }) as never);

    await drainQueue(db);

    // Merged into the sent row, the second save would be deleted with it
    // unsent. Its own row is left for the next pass, rebased onto the landing.
    expect(mockApi.patch.mock.calls.map((call) => call[1])).toEqual([{ content: 'A', base_version: 5 }]);
    expect(await rows()).toEqual([['update', { content: 'AB', base_version: 6 }]]);
  });

  it('sends a row as it is when the drain reaches it, merges since the pass loaded it included', async () => {
    await enqueueAll(update({ content: 'Other', base_version: 2 }, OTHER_ID), update({ content: 'A', base_version: 5 }));
    mockApi.patch
      .mockImplementationOnce((async () => {
        // The pass loaded NOTE_ID's row before this merge into it.
        await enqueueAll(update({ content: 'AB', base_version: 5 }));
        return ok('Other', OTHER_ID);
      }) as never)
      .mockResolvedValueOnce(ok('AB'));

    await drainQueue(db);

    expect(mockApi.patch.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [`/notes/${OTHER_ID}`, { content: 'Other', base_version: 2 }],
      [`/notes/${NOTE_ID}`, { content: 'AB', base_version: 5 }],
    ]);
    expect(await rows()).toEqual([]);
  });

  it('merges into a row again once a pass has left it queued', async () => {
    await enqueueAll(update({ content: 'A', base_version: 5 }));
    mockApi.patch.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true }));
    silenceConsole('info', /^Queue drain stopped at entry/);
    await drainQueue(db);

    await enqueueAll(update({ content: 'AB', base_version: 5 }));

    expect(await rows()).toEqual([['update', { content: 'AB', base_version: 5 }]]);
  });

  it('dead-letters one failed change for a conflicting offline session', async () => {
    silenceConsole('warn', /^Discarding queued operation/);
    await enqueueAll(...['A', 'AB', 'ABC'].map((content) => update({ content, base_version: 5 })));
    mockApi.patch.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 409'), {
      isAxiosError: true,
      response: { status: 409 },
    }));

    const { discardedOperations } = await drainQueue(db);

    expect(discardedOperations).toHaveLength(1);
    expect(await db.getAllAsync('SELECT id FROM dead_letter')).toHaveLength(1);
  });
});
