import { describe, it, expect } from 'vitest';
import {
  buildScalarPatch,
  createItemRequest,
  diffItems,
  itemSnapshot,
  itemsDiffer,
  patchTouchesSharedContent,
  type ItemSnapshot,
  type NoteScalars,
} from '../itemDiff';
import type { ListItem } from '../listItems';

const item = (id: string, overrides: Partial<Omit<ListItem, 'id'>> = {}): ListItem => ({
  id,
  text: id,
  completed: false,
  position: 0,
  parentId: null,
  assigned_to: '',
  ...overrides,
});

// The baseline an editor holds right after adopting `items` from the server.
const baselineOf = (items: ListItem[]): { saved: Map<string, ItemSnapshot>; order: string[] } => ({
  saved: new Map(items.map(it => [it.id, itemSnapshot(it)] as const)),
  order: items.map(it => it.id),
});

const scalars = (overrides: Partial<NoteScalars> = {}): NoteScalars => ({
  title: '',
  content: '',
  pinned: false,
  archived: false,
  color: '#ffffff',
  checked_items_collapsed: false,
  ...overrides,
});

describe('itemSnapshot', () => {
  it('keeps only the mergeable fields, not position', () => {
    expect(itemSnapshot(item('a', { text: 'x', completed: true, parentId: 'p', assigned_to: 'u', position: 3 }))).toEqual({
      text: 'x',
      completed: true,
      parentId: 'p',
      assigned_to: 'u',
    });
  });
});

describe('createItemRequest', () => {
  it("sends '' for a top-level item, matching the server's string parent_id", () => {
    expect(createItemRequest(item('a')).parent_id).toBe('');
  });

  it('sends the parent id for a nested item', () => {
    expect(createItemRequest(item('b', { parentId: 'a' })).parent_id).toBe('a');
  });

  it('omits an empty assignee and includes a set one', () => {
    expect(createItemRequest(item('a'))).not.toHaveProperty('assigned_to');
    expect(createItemRequest(item('a', { assigned_to: 'u1' })).assigned_to).toBe('u1');
  });
});

describe('diffItems', () => {
  it('returns nothing when the items match the baseline', () => {
    const items = [item('a'), item('b', { parentId: 'a' })];
    const { saved, order } = baselineOf(items);
    expect(diffItems(saved, order, items)).toEqual([]);
  });

  it('creates items missing from the baseline, in list order so parents precede children', () => {
    const { saved, order } = baselineOf([]);
    const ops = diffItems(saved, order, [item('p', { position: 0 }), item('c', { parentId: 'p', position: 1 })]);
    expect(ops.map(op => op.kind)).toEqual(['create', 'create', 'reorder']);
    expect(ops[0]).toMatchObject({ kind: 'create', itemId: 'p', request: { id: 'p', parent_id: '', position: 0 } });
    expect(ops[1]).toMatchObject({ kind: 'create', itemId: 'c', request: { id: 'c', parent_id: 'p', position: 1 } });
  });

  it('patches only the fields that changed', () => {
    const { saved, order } = baselineOf([item('a', { text: 'old', completed: false })]);
    const ops = diffItems(saved, order, [item('a', { text: 'new', completed: false })]);
    expect(ops).toEqual([
      { kind: 'patch', itemId: 'a', patch: { text: 'new' }, snapshot: itemSnapshot(item('a', { text: 'new' })) },
    ]);
  });

  it("patches an outdent with parent_id '' (null would mean unchanged)", () => {
    const { saved, order } = baselineOf([item('p'), item('c', { parentId: 'p' })]);
    const ops = diffItems(saved, order, [item('p'), item('c')]);
    expect(ops).toEqual([
      { kind: 'patch', itemId: 'c', patch: { parent_id: '' }, snapshot: itemSnapshot(item('c')) },
    ]);
  });

  it('patches completed and assigned_to changes', () => {
    const { saved, order } = baselineOf([item('a')]);
    const ops = diffItems(saved, order, [item('a', { completed: true, assigned_to: 'u1' })]);
    expect(ops).toEqual([
      expect.objectContaining({ kind: 'patch', patch: { completed: true, assigned_to: 'u1' } }),
    ]);
  });

  it('ignores a position-only change (order is diffed separately)', () => {
    const { saved, order } = baselineOf([item('a', { position: 0 })]);
    expect(diffItems(saved, order, [item('a', { position: 7 })])).toEqual([]);
  });

  it('deletes baseline items no longer present, after creates and patches', () => {
    const { saved, order } = baselineOf([item('a'), item('b')]);
    const ops = diffItems(saved, order, [item('a', { text: 'edited' }), item('n')]);
    expect(ops.map(op => op.kind)).toEqual(['patch', 'create', 'delete', 'reorder']);
    expect(ops[2]).toEqual({ kind: 'delete', itemId: 'b' });
  });

  it('emits a single reorder, last, when only the order changed', () => {
    const { saved, order } = baselineOf([item('a'), item('b')]);
    expect(diffItems(saved, order, [item('b'), item('a')])).toEqual([{ kind: 'reorder', itemIds: ['b', 'a'] }]);
  });

  it('emits no reorder for an emptied list, only the deletes', () => {
    const { saved, order } = baselineOf([item('a'), item('b')]);
    expect(diffItems(saved, order, [])).toEqual([
      { kind: 'delete', itemId: 'a' },
      { kind: 'delete', itemId: 'b' },
    ]);
  });
});

describe('itemsDiffer', () => {
  it('is false for items matching the baseline', () => {
    const items = [item('a'), item('b')];
    const { saved, order } = baselineOf(items);
    expect(itemsDiffer(saved, order, items)).toBe(false);
  });

  it('is true for any field, membership or order change', () => {
    const items = [item('a'), item('b')];
    const { saved, order } = baselineOf(items);
    expect(itemsDiffer(saved, order, [item('a', { text: 'x' }), item('b')])).toBe(true);
    expect(itemsDiffer(saved, order, [item('a')])).toBe(true);
    expect(itemsDiffer(saved, order, [item('b'), item('a')])).toBe(true);
  });

  it('is true when only the saved order is stale, even with no operation left to send', () => {
    expect(itemsDiffer(new Map(), ['a'], [])).toBe(true);
  });
});

describe('buildScalarPatch', () => {
  it('returns null when nothing changed', () => {
    expect(buildScalarPatch('text', scalars({ content: 'x' }), scalars({ content: 'x' }))).toBeNull();
  });

  it('sends content, never title or collapse state, for a text note', () => {
    const patch = buildScalarPatch(
      'text',
      scalars({ content: 'new', title: 'ignored', checked_items_collapsed: true }),
      scalars({ content: 'old' }),
    );
    expect(patch).toEqual({ content: 'new' });
  });

  it('sends title and collapse state, never content, for a list note', () => {
    const patch = buildScalarPatch(
      'list',
      scalars({ title: 'T', checked_items_collapsed: true, content: 'ignored' }),
      scalars(),
    );
    expect(patch).toEqual({ title: 'T', checked_items_collapsed: true });
  });

  it('sends pinned, archived and color for either type', () => {
    const current = scalars({ pinned: true, archived: true, color: '#ff0000' });
    expect(buildScalarPatch('text', current, scalars())).toEqual({ pinned: true, archived: true, color: '#ff0000' });
    expect(buildScalarPatch('list', current, scalars())).toEqual({ pinned: true, archived: true, color: '#ff0000' });
  });

  it('never includes base_version', () => {
    expect(buildScalarPatch('text', scalars({ content: 'x' }), scalars())).not.toHaveProperty('base_version');
  });
});

describe('patchTouchesSharedContent', () => {
  it('is true for title or content, false for per-user fields', () => {
    expect(patchTouchesSharedContent({ content: 'x' })).toBe(true);
    expect(patchTouchesSharedContent({ title: '' })).toBe(true);
    expect(patchTouchesSharedContent({ pinned: true, color: '#fff' })).toBe(false);
  });
});
