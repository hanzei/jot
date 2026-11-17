import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VALIDATION, type Note, type ListNote } from '@jot/shared';
import {
  useCreateNote,
  useDeleteNote,
  useRestoreNote,
  usePermanentDeleteNote,
  useDuplicateNote,
  useConvertNoteType,
  useCreateNoteItem,
  useUpdateNoteItem,
  useDeleteNoteItem,
  useReorderNoteItems,
  useToggleNoteItemCompleted,
  useUncheckAllItems,
  useDeleteCompletedItems,
  useShareNote,
  useUnshareNote,
  useLeaveNote,
  useMarkNoteViewed,
  NoteConversionCapError,
} from '../src/hooks/useNotes';
import { noteLocalQueryKey } from '../src/hooks/queryKeys';
import {
  getLocalNote,
  getNextLocalPinnedPosition,
  getPendingCreateNoteIds,
  getStoredLabels,
  saveNote,
  upsertLabel,
} from '../src/db/noteQueries';
import { recordOwnVersionStep } from '../src/db/ownVersions';
import { setLocalModeActive } from '../src/store/localMode';
import * as clientModule from '../src/api/client';
import { jot } from '../src/api/jot';
import { makeLabel, makeListNote, makeNoteItem, makeTextNote, queuedOps, seedImageUpload } from './helpers/fixtures';
import { getPendingImageUploads } from '../src/db/imageUploadQueue';
import type { TestDatabase } from './helpers/testDb';

jest.mock('../src/api/jot');

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({ user: { id: 'test-user-id', username: 'testuser' }, isAuthenticated: true }),
}));

jest.mock('../src/api/client', () => {
  const isServerSwitchInProgress = jest.fn(() => false);
  return {
    ...jest.requireActual('../src/api/client'),
    isServerSwitchInProgress,
    assertSwitchWriteAllowed: jest.fn(() => {
      if (isServerSwitchInProgress()) throw new Error('Server switch in progress; write blocked');
    }),
  };
});

const mockClient = clientModule as jest.Mocked<typeof clientModule>;

/** A server-format id (22 base62 characters): what the server accepts as a client-supplied id. */
const ID_RE = /^[0-9a-zA-Z]{22}$/;

const TEXT_ID = 'TextNote00000000000000';
const LIST_ID = 'ListNote00000000000000';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper: Wrapper, queryClient };
}

/** Mounts a mutation hook and returns a runner that performs one mutation inside act. */
async function mountMutation<TVars, TResult>(
  useHook: () => { mutateAsync: (vars: TVars) => Promise<TResult> },
  wrapper = createWrapper().wrapper,
): Promise<(vars: TVars) => Promise<TResult>> {
  const { result } = await renderHook(() => useHook(), { wrapper });
  return async (vars) => {
    let returned!: TResult;
    await act(async () => {
      returned = await result.current.mutateAsync(vars);
    });
    return returned;
  };
}

/** Every function of the mocked API client: an outbox write must call none of them. */
function expectNoServerCalls(): void {
  const called: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (jest.isMockFunction(value)) {
      if (value.mock.calls.length > 0) called.push(path);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    }
  };
  visit(jot, 'jot');
  expect(called).toEqual([]);
}

function listItems(note: Note | null): ListNote['items'] & object {
  if (note?.note_type !== 'list') throw new Error('expected a list note');
  return note.items ?? [];
}

/**
 * Every write hook here goes through the outbox (#1285): the local edit and
 * its queue rows commit in one transaction, and the hook never calls the
 * server, whatever the connectivity. Runs against the real SQLite adapter.
 */
describe('useNotes write hooks (outbox)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient.isServerSwitchInProgress.mockReturnValue(false);
    db = globalThis.testDb;
    await saveNote(db, makeTextNote({ id: TEXT_ID, content: 'Buy milk', version: 3 }));
    await saveNote(db, makeListNote({
      id: LIST_ID,
      title: 'Groceries',
      version: 2,
      items: [
        makeNoteItem({ id: 'ParentItem000000000000', note_id: LIST_ID, text: 'Fruit', position: 0 }),
        makeNoteItem({ id: 'ChildItem0000000000000', note_id: LIST_ID, text: 'Apples', position: 1, parent_id: 'ParentItem000000000000' }),
        makeNoteItem({ id: 'OtherItem0000000000000', note_id: LIST_ID, text: 'Bread', position: 2 }),
      ],
    }));
  });

  afterEach(() => {
    setLocalModeActive(false);
    expectNoServerCalls();
  });

  describe('useCreateNote', () => {
    it('saves the note under a server-valid client id, flags it pending and queues its create (#475, #1278)', async () => {
      const create = await mountMutation(() => useCreateNote());

      const created = await create({ content: 'Offline note', note_type: 'text' });

      expect(created.id).toMatch(ID_RE);
      expect(await getLocalNote(db, created.id)).toMatchObject({ content: 'Offline note', version: 1 });
      expect(await getPendingCreateNoteIds(db)).toEqual(new Set([created.id]));
      // The replay sends the same id, so a create the server already committed
      // comes back as a 409 rather than a second note.
      expect(await queuedOps(db)).toEqual([{
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body: { id: created.id, content: 'Offline note', note_type: 'text' },
        keys: [`note:${created.id}`],
        readKeys: [],
      }]);
    });

    it('pre-assigns server-format item ids and parents indented items by them (#513)', async () => {
      const create = await mountMutation(() => useCreateNote());

      const created = await create({
        title: 'Groceries',
        note_type: 'list',
        items: [
          { text: 'Fruit', position: 0 },
          { text: 'Apples', position: 1, indent_level: 1 },
        ],
      });

      const items = listItems(await getLocalNote(db, created.id));
      expect(items.map((i) => i.text)).toEqual(['Fruit', 'Apples']);
      for (const item of items) expect(item.id).toMatch(ID_RE);
      expect(items[1]!.parent_id).toBe(items[0]!.id);
      // The create carries the same ids, so the server keeps them and a per-item
      // edit queued behind it targets a valid item.
      const [op] = await queuedOps(db);
      expect((op!.body!.items as { id: string }[]).map((i) => i.id)).toEqual(items.map((i) => i.id));
    });

    it('places a pinned note at the end of the pinned section and asks the server to pin it', async () => {
      await saveNote(db, makeTextNote({ id: 'PinnedNote000000000000', pinned: true, position: 4 }));
      const expectedPosition = await getNextLocalPinnedPosition(db);
      const create = await mountMutation(() => useCreateNote());

      const created = await create({ content: 'Pinned', note_type: 'text', pinned: true });

      expect(expectedPosition).toBe(5);
      expect(await getLocalNote(db, created.id)).toMatchObject({ pinned: true, position: 5 });
      expect((await queuedOps(db))[0]!.body).toMatchObject({ pinned: true });
    });

    it('attaches the named labels, queueing the create of an unknown one ahead of the note', async () => {
      const work = makeLabel({ id: 'WorkLabel0000000000000', name: 'Work' });
      await upsertLabel(db, work);
      const create = await mountMutation(() => useCreateNote());

      const created = await create({ content: 'Labelled', note_type: 'text', labels: ['work', 'Errands'] });

      // A known label is reused (matched case-insensitively); a new one is minted
      // and stored, and its create lands first so the note's create resolves the
      // name to that same id.
      const errands = (await getStoredLabels(db)).find((l) => l.name === 'Errands');
      expect(errands?.id).toMatch(ID_RE);
      expect((await getLocalNote(db, created.id))!.labels.map((l) => l.id)).toEqual([work.id, errands!.id]);
      expect(await queuedOps(db)).toEqual([
        {
          operation: 'createLabel',
          endpoint: '/labels',
          method: 'POST',
          body: { id: errands!.id, name: 'Errands' },
          keys: [`label:${errands!.id}`],
          readKeys: [],
        },
        expect.objectContaining({
          operation: 'create',
          body: expect.objectContaining({ labels: ['work', 'Errands'] }),
          keys: [`note:${created.id}`, `label:${work.id}`, `label:${errands!.id}`],
        }),
      ]);
    });

    it('writes nothing while a server switch is in progress', async () => {
      mockClient.isServerSwitchInProgress.mockReturnValue(true);
      const create = await mountMutation(() => useCreateNote());

      await expect(create({ content: 'Blocked', note_type: 'text' })).rejects.toThrow('Server switch in progress');

      expect(await queuedOps(db)).toEqual([]);
      expect(await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM notes')).toEqual({ n: 2 });
    });

    it('keeps the note but queues nothing in local mode (#514)', async () => {
      setLocalModeActive(true);
      const create = await mountMutation(() => useCreateNote());

      const created = await create({ content: 'Local only', note_type: 'text' });

      expect(await getLocalNote(db, created.id)).toMatchObject({ content: 'Local only' });
      expect(await queuedOps(db)).toEqual([]);
    });
  });

  describe('useDuplicateNote', () => {
    it('copies a text note under a client id at version 1, keyed by the copy and reading the source', async () => {
      await saveNote(db, makeTextNote({ id: TEXT_ID, content: 'Buy milk', version: 3, pinned: true }));
      const duplicate = await mountMutation(() => useDuplicateNote());

      const copy = await duplicate(TEXT_ID);

      expect(copy.id).toMatch(ID_RE);
      expect(await getLocalNote(db, copy.id)).toMatchObject({ content: 'Buy milk', version: 1, pinned: false });
      expect(await getPendingCreateNoteIds(db)).toEqual(new Set([copy.id]));
      expect(await queuedOps(db)).toEqual([{
        operation: 'duplicate',
        endpoint: `/notes/${TEXT_ID}/duplicate`,
        method: 'POST',
        body: { id: copy.id },
        keys: [`note:${copy.id}`],
        // The source's queued writes land first; the duplicate does not write it.
        readKeys: [`note:${TEXT_ID}`],
      }]);
    });

    it('gives the copied items new server-format ids with remapped parents, and sends the mapping (#513)', async () => {
      const duplicate = await mountMutation(() => useDuplicateNote());

      const copy = await duplicate(LIST_ID);

      const items = listItems(await getLocalNote(db, copy.id));
      expect(items.map((i) => i.text)).toEqual(['Fruit', 'Apples', 'Bread']);
      for (const item of items) expect(item.id).toMatch(ID_RE);
      expect(items[0]!.id).not.toBe('ParentItem000000000000');
      expect(items[1]!.parent_id).toBe(items[0]!.id);
      expect((await queuedOps(db))[0]!.body).toEqual({
        id: copy.id,
        item_ids: {
          ParentItem000000000000: items[0]!.id,
          ChildItem0000000000000: items[1]!.id,
          OtherItem0000000000000: items[2]!.id,
        },
      });
    });

    it('rejects and writes nothing when the source is not stored locally', async () => {
      const duplicate = await mountMutation(() => useDuplicateNote());

      await expect(duplicate('MissingNote00000000000')).rejects.toThrow(/not found in local DB/);

      expect(await queuedOps(db)).toEqual([]);
    });
  });

  describe('useConvertNoteType', () => {
    it('converts text to a list locally, promoting a heading to the title, and queues it version-guarded', async () => {
      await saveNote(db, makeTextNote({ id: TEXT_ID, content: '## Groceries\nBuy milk\nBuy eggs', version: 3 }));
      const convert = await mountMutation(() => useConvertNoteType());

      const converted = await convert({ id: TEXT_ID });

      const local = await getLocalNote(db, TEXT_ID);
      expect(local).toMatchObject({ note_type: 'list', title: 'Groceries' });
      const items = listItems(local);
      expect(items.map((i) => i.text)).toEqual(['Buy milk', 'Buy eggs']);
      expect(converted).toMatchObject({ note_type: 'list', title: 'Groceries' });
      expect(await queuedOps(db)).toEqual([{
        operation: 'convertNoteType',
        endpoint: `/notes/${TEXT_ID}/convert`,
        method: 'POST',
        body: {
          note_type: 'list',
          title: 'Groceries',
          // The same ids as the local rows, so a per-item edit queued behind it matches.
          items: items.map((i, index) => ({ id: i.id, text: i.text, position: index, completed: false, indent_level: 0 })),
          base_version: 3,
        },
        keys: [`note:${TEXT_ID}`],
        readKeys: [],
      }]);
    });

    it('stores the editor-supplied baseVersion, advanced past this device\'s own landed edits (#1277)', async () => {
      // The editor showed v2; its save from v2 has since landed as v3.
      recordOwnVersionStep(db, TEXT_ID, 2, 3);
      await saveNote(db, makeTextNote({ id: TEXT_ID, content: 'Buy milk', version: 9 }));
      const convert = await mountMutation(() => useConvertNoteType());

      await convert({ id: TEXT_ID, baseVersion: 2 });

      expect((await queuedOps(db))[0]!.body).toMatchObject({ base_version: 3 });
    });

    it('rebuilds parent_id from indent_level locally, as the server does on replay', async () => {
      // An indented first line has no top-level item to hang off, so it stays
      // top-level and does not adopt the item after it.
      await saveNote(db, makeTextNote({ id: TEXT_ID, content: '  - Orphan\n- Parent\n  - Child', version: 3 }));
      const convert = await mountMutation(() => useConvertNoteType());

      await convert({ id: TEXT_ID });

      const items = listItems(await getLocalNote(db, TEXT_ID));
      expect(items.map((i) => [i.text, i.parent_id])).toEqual([
        ['Orphan', null],
        ['Parent', null],
        ['Child', items[1]!.id],
      ]);
      const body = (await queuedOps(db))[0]!.body as { items: { indent_level: number }[] };
      expect(body.items.map((i) => i.indent_level)).toEqual([1, 0, 1]);
    });

    it('converts a list to text locally and queues the precomputed content', async () => {
      const convert = await mountMutation(() => useConvertNoteType());

      const converted = await convert({ id: LIST_ID });

      const local = await getLocalNote(db, LIST_ID);
      expect(local?.note_type).toBe('text');
      // The returned (and cached) note is a text note, as SQLite stored it.
      expect(converted).toEqual(local);
      expect(converted).not.toHaveProperty('title');
      expect(converted).not.toHaveProperty('items');
      expect((await queuedOps(db))[0]!.body).toEqual({
        note_type: 'text',
        content: local?.note_type === 'text' ? local.content : null,
        base_version: 2,
      });
      expect(local?.note_type === 'text' && local.content).toContain('Groceries');
    });

    it('throws NoteConversionCapError and writes nothing when the item cap is exceeded', async () => {
      const content = Array.from({ length: VALIDATION.ITEM_MAX_COUNT + 1 }, (_, i) => `Item ${i}`).join('\n');
      await saveNote(db, makeTextNote({ id: TEXT_ID, content, version: 3 }));
      const convert = await mountMutation(() => useConvertNoteType());

      const error = await convert({ id: TEXT_ID }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NoteConversionCapError);
      expect(error).toMatchObject({ kind: 'tooManyItems', max: VALIDATION.ITEM_MAX_COUNT });
      expect(await getLocalNote(db, TEXT_ID)).toMatchObject({ note_type: 'text', content });
      expect(await queuedOps(db)).toEqual([]);
    });

    it('throws NoteConversionCapError when an item line exceeds the text length cap', async () => {
      await saveNote(db, makeTextNote({ id: TEXT_ID, content: 'x'.repeat(VALIDATION.ITEM_TEXT_MAX_LENGTH + 1), version: 3 }));
      const convert = await mountMutation(() => useConvertNoteType());

      const error = await convert({ id: TEXT_ID }).catch((err: unknown) => err);

      expect(error).toMatchObject({ kind: 'itemTextTooLong', max: VALIDATION.ITEM_TEXT_MAX_LENGTH });
      expect(await queuedOps(db)).toEqual([]);
    });
  });

  describe('item mutations', () => {
    it('useCreateNoteItem stores the item under a pre-assigned id and queues that id', async () => {
      const createItem = await mountMutation(() => useCreateNoteItem());

      await createItem({ noteId: LIST_ID, item: { text: 'Milk', position: 3 } });

      const added = listItems(await getLocalNote(db, LIST_ID)).find((i) => i.text === 'Milk');
      expect(added?.id).toMatch(ID_RE);
      expect(await queuedOps(db)).toEqual([{
        operation: 'createItem',
        endpoint: `/notes/${LIST_ID}/items`,
        method: 'POST',
        body: { id: added!.id, text: 'Milk', position: 3 },
        keys: [`note:${LIST_ID}`],
        readKeys: [],
      }]);
    });

    it('useUpdateNoteItem patches the item and queues only the changed fields', async () => {
      const updateItem = await mountMutation(() => useUpdateNoteItem());

      await updateItem({ noteId: LIST_ID, itemId: 'OtherItem0000000000000', data: { text: 'Rye bread' } });

      expect(listItems(await getLocalNote(db, LIST_ID)).find((i) => i.id === 'OtherItem0000000000000')?.text).toBe('Rye bread');
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'updateItem',
        endpoint: `/notes/${LIST_ID}/items/OtherItem0000000000000`,
        method: 'PATCH',
        body: { text: 'Rye bread' },
        keys: [`note:${LIST_ID}`],
      })]);
    });

    it('useDeleteNoteItem removes the item and queues the delete', async () => {
      const deleteItem = await mountMutation(() => useDeleteNoteItem());

      await deleteItem({ noteId: LIST_ID, itemId: 'OtherItem0000000000000' });

      expect(listItems(await getLocalNote(db, LIST_ID)).map((i) => i.id)).not.toContain('OtherItem0000000000000');
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'deleteItem',
        endpoint: `/notes/${LIST_ID}/items/OtherItem0000000000000`,
        method: 'DELETE',
        body: null,
        keys: [`note:${LIST_ID}`],
      })]);
    });

    it('useReorderNoteItems writes the new order and queues it', async () => {
      const reorder = await mountMutation(() => useReorderNoteItems());
      const order = ['OtherItem0000000000000', 'ParentItem000000000000', 'ChildItem0000000000000'];

      await reorder({ noteId: LIST_ID, itemIds: order });

      const items = [...listItems(await getLocalNote(db, LIST_ID))].sort((a, b) => a.position - b.position);
      expect(items.map((i) => i.id)).toEqual(order);
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'reorderItems',
        endpoint: `/notes/${LIST_ID}/items/reorder`,
        method: 'POST',
        body: { item_ids: order },
      })]);
    });
  });

  describe('completed flags', () => {
    function completedById(note: Note | null): Record<string, boolean> {
      return Object.fromEntries(listItems(note).map((i) => [i.id, i.completed]));
    }

    it('useToggleNoteItemCompleted writes the cascade to SQLite and queues only the tapped item', async () => {
      const { wrapper, queryClient } = createWrapper();
      queryClient.setQueryData(noteLocalQueryKey(LIST_ID), await getLocalNote(db, LIST_ID));
      const toggle = await mountMutation(() => useToggleNoteItemCompleted(), wrapper);

      const committed = await toggle({ noteId: LIST_ID, itemId: 'ParentItem000000000000', completed: true });

      expect(committed).toEqual(['ParentItem000000000000', 'ChildItem0000000000000']);
      // Checking a parent checks its children, in SQLite as in the cache; the
      // server applies the same cascade to the one id it is sent.
      const expected = { ParentItem000000000000: true, ChildItem0000000000000: true, OtherItem0000000000000: false };
      expect(completedById(await getLocalNote(db, LIST_ID))).toEqual(expected);
      expect(completedById(queryClient.getQueryData<Note>(noteLocalQueryKey(LIST_ID)) ?? null)).toEqual(expected);
      expect(await queuedOps(db)).toEqual([{
        operation: 'setItemsCompleted',
        endpoint: `/notes/${LIST_ID}/items/set-completed`,
        method: 'POST',
        body: { item_ids: ['ParentItem000000000000'], completed: true },
        keys: [`note:${LIST_ID}`],
        readKeys: [],
      }]);
    });

    it('useToggleNoteItemCompleted resolves to the cascade as SQLite scopes it, not the editor', async () => {
      // The editor indented "Bread" under "Fruit", but that is not saved yet.
      const toggle = await mountMutation(() => useToggleNoteItemCompleted());
      await toggle({ noteId: LIST_ID, itemId: 'ChildItem0000000000000', completed: true });

      const committed = await toggle({ noteId: LIST_ID, itemId: 'ParentItem000000000000', completed: true });

      // The child already held the value, so it counts; "Bread" is not in the
      // stored cascade and stays for the editor's next save.
      expect(committed).toEqual(['ParentItem000000000000', 'ChildItem0000000000000']);
      expect(completedById(await getLocalNote(db, LIST_ID))).toMatchObject({ OtherItem0000000000000: false });
    });

    it('useToggleNoteItemCompleted un-completes a completed parent when a child is unchecked', async () => {
      const toggle = await mountMutation(() => useToggleNoteItemCompleted());
      await toggle({ noteId: LIST_ID, itemId: 'ParentItem000000000000', completed: true });

      await toggle({ noteId: LIST_ID, itemId: 'ChildItem0000000000000', completed: false });

      expect(completedById(await getLocalNote(db, LIST_ID))).toMatchObject({
        ParentItem000000000000: false,
        ChildItem0000000000000: false,
      });
      expect((await queuedOps(db)).map((op) => op.body)).toEqual([
        { item_ids: ['ParentItem000000000000'], completed: true },
        { item_ids: ['ChildItem0000000000000'], completed: false },
      ]);
    });

    it('useUncheckAllItems unchecks exactly the given ids and queues them', async () => {
      const toggle = await mountMutation(() => useToggleNoteItemCompleted());
      await toggle({ noteId: LIST_ID, itemId: 'ParentItem000000000000', completed: true });
      await toggle({ noteId: LIST_ID, itemId: 'OtherItem0000000000000', completed: true });
      await db.runAsync('DELETE FROM sync_queue');
      const uncheckAll = await mountMutation(() => useUncheckAllItems());

      const committed = await uncheckAll({ noteId: LIST_ID, itemIds: ['ParentItem000000000000', 'ChildItem0000000000000'] });

      expect(committed).toEqual(['ParentItem000000000000', 'ChildItem0000000000000']);
      expect(completedById(await getLocalNote(db, LIST_ID))).toEqual({
        ParentItem000000000000: false,
        ChildItem0000000000000: false,
        OtherItem0000000000000: true,
      });
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'setItemsCompleted',
        body: { item_ids: ['ParentItem000000000000', 'ChildItem0000000000000'], completed: false },
      })]);
    });

    it('useUncheckAllItems queues nothing for an empty set', async () => {
      const uncheckAll = await mountMutation(() => useUncheckAllItems());

      await uncheckAll({ noteId: LIST_ID, itemIds: [] });

      expect(await queuedOps(db)).toEqual([]);
    });

    it('useDeleteCompletedItems removes exactly the given ids and queues one bulk delete', async () => {
      const deleteCompleted = await mountMutation(() => useDeleteCompletedItems());

      await deleteCompleted({ noteId: LIST_ID, itemIds: ['ParentItem000000000000', 'ChildItem0000000000000'] });

      expect(listItems(await getLocalNote(db, LIST_ID)).map((i) => i.id)).toEqual(['OtherItem0000000000000']);
      expect(await queuedOps(db)).toEqual([{
        operation: 'deleteCompletedItems',
        endpoint: `/notes/${LIST_ID}/items/delete`,
        method: 'POST',
        body: { item_ids: ['ParentItem000000000000', 'ChildItem0000000000000'] },
        keys: [`note:${LIST_ID}`],
        readKeys: [],
      }]);
    });
  });

  describe('trash, restore and permanent delete', () => {
    it('useDeleteNote trashes the note locally and queues the delete', async () => {
      const del = await mountMutation(() => useDeleteNote());

      await del(TEXT_ID);

      expect((await getLocalNote(db, TEXT_ID))?.deleted_at).not.toBeNull();
      expect(await queuedOps(db)).toEqual([{
        operation: 'delete', endpoint: `/notes/${TEXT_ID}`, method: 'DELETE', body: null, keys: [`note:${TEXT_ID}`], readKeys: [],
      }]);
    });

    it('useRestoreNote restores the note locally and queues the restore', async () => {
      await saveNote(db, makeTextNote({ id: TEXT_ID, deleted_at: '2026-01-02T00:00:00Z', archived: true }));
      const restore = await mountMutation(() => useRestoreNote());

      await restore(TEXT_ID);

      expect(await getLocalNote(db, TEXT_ID)).toMatchObject({ deleted_at: null, archived: false });
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'restore', endpoint: `/notes/${TEXT_ID}/restore`, method: 'POST', keys: [`note:${TEXT_ID}`],
      })]);
    });

    it('usePermanentDeleteNote removes the note locally and queues the delete', async () => {
      const del = await mountMutation(() => usePermanentDeleteNote());

      await del(TEXT_ID);

      expect(await getLocalNote(db, TEXT_ID)).toBeNull();
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'permanentDelete', endpoint: `/notes/${TEXT_ID}?permanent=true`, method: 'DELETE', keys: [`note:${TEXT_ID}`],
      })]);
    });
  });

  describe('useMarkNoteViewed', () => {
    it('clears the badge locally and queues the view with the time the user looked', async () => {
      await saveNote(db, makeTextNote({ id: TEXT_ID, unread: 'new' }));
      const markViewed = await mountMutation(() => useMarkNoteViewed());

      await markViewed(TEXT_ID);

      expect((await getLocalNote(db, TEXT_ID))?.unread).toBeNull();
      const [op] = await queuedOps(db);
      expect(op).toMatchObject({ operation: 'markViewed', endpoint: `/notes/${TEXT_ID}/viewed`, method: 'POST', keys: [`note:${TEXT_ID}`] });
      expect(Number.isNaN(Date.parse(op!.body!.viewed_at as string))).toBe(false);
    });

    it('does nothing during a server switch', async () => {
      await saveNote(db, makeTextNote({ id: TEXT_ID, unread: 'new' }));
      mockClient.isServerSwitchInProgress.mockReturnValue(true);
      const markViewed = await mountMutation(() => useMarkNoteViewed());

      await markViewed(TEXT_ID);

      expect((await getLocalNote(db, TEXT_ID))?.unread).toBe('new');
      expect(await queuedOps(db)).toEqual([]);
    });
  });

  describe('sharing', () => {
    const collaborator = { id: 'CollabUser000000000000', username: 'collab', first_name: 'Col', last_name: 'Lab', has_profile_icon: false };

    it('useShareNote adds an optimistic share row and queues the share', async () => {
      const share = await mountMutation(() => useShareNote());

      await share({ noteId: TEXT_ID, user: collaborator as never });

      const local = await getLocalNote(db, TEXT_ID);
      expect(local?.is_shared).toBe(true);
      expect(local?.shared_with).toEqual([expect.objectContaining({
        shared_with_user_id: collaborator.id,
        shared_by_user_id: 'test-user-id',
        username: 'collab',
      })]);
      expect(await queuedOps(db)).toEqual([{
        operation: 'share',
        endpoint: `/notes/${TEXT_ID}/share`,
        method: 'POST',
        body: { user_id: collaborator.id },
        keys: [`note:${TEXT_ID}`],
        readKeys: [],
      }]);
    });

    it('useUnshareNote drops the share row and queues the unshare', async () => {
      const share = await mountMutation(() => useShareNote());
      await share({ noteId: TEXT_ID, user: collaborator as never });
      const unshare = await mountMutation(() => useUnshareNote());

      await unshare({ noteId: TEXT_ID, userId: collaborator.id });

      expect(await getLocalNote(db, TEXT_ID)).toMatchObject({ is_shared: false, shared_with: [] });
      expect((await queuedOps(db))[1]).toEqual({
        operation: 'unshare',
        endpoint: `/notes/${TEXT_ID}/shares/${collaborator.id}`,
        method: 'DELETE',
        body: null,
        keys: [`note:${TEXT_ID}`],
        readKeys: [],
      });
    });

    it('useLeaveNote deletes the note locally and queues the removal of the user\'s own share', async () => {
      const leave = await mountMutation(() => useLeaveNote());

      await leave({ noteId: TEXT_ID });

      expect(await getLocalNote(db, TEXT_ID)).toBeNull();
      expect(await queuedOps(db)).toEqual([expect.objectContaining({
        operation: 'unshare',
        endpoint: `/notes/${TEXT_ID}/shares/test-user-id`,
        method: 'DELETE',
        keys: [`note:${TEXT_ID}`],
      })]);
    });
  });

  describe('the queued image uploads of a note deleted for good', () => {
    // Queued uploads are sync_queue rows (#1288); failed ones pending_image_uploads rows.
    const uploadRows = async () => (await getPendingImageUploads(db, TEXT_ID)).map(({ id }) => ({ id }));
    // Makes the outbox's queue insert fail, so the write's transaction rolls back.
    const failQueueInserts = () => db.execAsync(
      `CREATE TRIGGER fail_queue BEFORE INSERT ON sync_queue BEGIN SELECT RAISE(ABORT, 'queue insert failed'); END`,
    );

    it.each<[string, (vars: string) => Promise<unknown>]>([
      ['usePermanentDeleteNote', async (id) => (await mountMutation(() => usePermanentDeleteNote()))(id)],
      ['useLeaveNote', async (noteId) => (await mountMutation(() => useLeaveNote()))({ noteId })],
    ])('%s removes their files once the write has committed', async (_name, run) => {
      const upload = await seedImageUpload(db, { note_id: TEXT_ID });

      await run(TEXT_ID);

      expect(await uploadRows()).toEqual([]);
      expect(globalThis.mockFileSystem.files.has(upload.local_path)).toBe(false);
    });

    it.each<[string, (vars: string) => Promise<unknown>]>([
      ['usePermanentDeleteNote', async (id) => (await mountMutation(() => usePermanentDeleteNote()))(id)],
      ['useLeaveNote', async (noteId) => (await mountMutation(() => useLeaveNote()))({ noteId })],
    ])('%s keeps them, files included, when the write rolls back', async (_name, run) => {
      const upload = await seedImageUpload(db, { note_id: TEXT_ID });
      await failQueueInserts();

      await expect(run(TEXT_ID)).rejects.toThrow('queue insert failed');

      expect(await getLocalNote(db, TEXT_ID)).not.toBeNull();
      expect(await uploadRows()).toEqual([{ id: upload.id }]);
      expect(globalThis.mockFileSystem.files.has(upload.local_path)).toBe(true);
    });
  });
});
