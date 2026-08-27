import { describe, it, expect } from 'vitest';
import { applyCompletedCascade, dropTargetParentId, itemHasChildren, normalizeItemOrder, type ListItem } from '../listItems';

// Terse builder so each case reads as the structure under test rather than as
// six fields of boilerplate per item.
const item = (id: string, overrides: Partial<Omit<ListItem, 'id'>> = {}): ListItem => ({
  id,
  text: id,
  completed: false,
  position: 0,
  parentId: null,
  assigned_to: '',
  ...overrides,
});

const ids = (items: ListItem[]) => items.map(it => it.id);
const parents = (items: ListItem[]) => items.map(it => it.parentId);

describe('normalizeItemOrder', () => {
  it('assigns sequential positions across the whole set', () => {
    const result = normalizeItemOrder([item('a'), item('b'), item('c')]);
    expect(result.map(it => it.position)).toEqual([0, 1, 2]);
  });

  it('emits each child immediately after its parent so a group stays contiguous', () => {
    const result = normalizeItemOrder([
      item('a'),
      item('b'),
      item('a1', { parentId: 'a' }),
      item('b1', { parentId: 'b' }),
    ]);
    expect(ids(result)).toEqual(['a', 'a1', 'b', 'b1']);
  });

  it('keeps multiple children of one parent in their relative order', () => {
    const result = normalizeItemOrder([
      item('a'),
      item('a2', { parentId: 'a' }),
      item('a1', { parentId: 'a' }),
    ]);
    expect(ids(result)).toEqual(['a', 'a2', 'a1']);
  });

  it('promotes an orphan whose parent no longer exists instead of dropping it', () => {
    const result = normalizeItemOrder([item('a'), item('x', { parentId: 'gone' })]);
    expect(ids(result)).toEqual(['a', 'x']);
    expect(parents(result)).toEqual([null, null]);
  });

  it('promotes a grandchild, since a child can never itself be a parent', () => {
    const result = normalizeItemOrder([
      item('a'),
      item('a1', { parentId: 'a' }),
      item('a1x', { parentId: 'a1' }),
    ]);
    expect(ids(result)).toEqual(['a', 'a1', 'a1x']);
    expect(result.find(it => it.id === 'a1x')?.parentId).toBeNull();
  });

  it('preserves the relative slot of a checked item among its neighbours', () => {
    const result = normalizeItemOrder([
      item('a'),
      item('b', { completed: true }),
      item('c'),
    ]);
    expect(ids(result)).toEqual(['a', 'b', 'c']);
  });

  it('returns new objects rather than mutating the input', () => {
    const input = [item('a', { position: 99 })];
    const result = normalizeItemOrder(input);
    expect(input[0]!.position).toBe(99);
    expect(result[0]!.position).toBe(0);
  });

  it('handles an empty list', () => {
    expect(normalizeItemOrder([])).toEqual([]);
  });
});

describe('itemHasChildren', () => {
  const items = [item('a'), item('a1', { parentId: 'a' }), item('b')];

  it('is true for an item something is nested under', () => {
    expect(itemHasChildren(items, 'a')).toBe(true);
  });

  it('is false for a childless item and for an unknown id', () => {
    expect(itemHasChildren(items, 'b')).toBe(false);
    expect(itemHasChildren(items, 'nope')).toBe(false);
  });
});

describe('dropTargetParentId', () => {
  // 'x' deliberately sits between p1 and its only child c1, so p1's child is
  // not the row immediately above it in the raw array — the case the two
  // historical per-client implementations disagreed on (issue #895).
  const items = [item('p1'), item('x'), item('c1', { parentId: 'p1' }), item('p2')];

  it('keeps an item with children top-level, since it cannot become a child', () => {
    expect(dropTargetParentId(items, item('x'), 'p1')).toBeNull();
  });

  it('returns null when dropped at the very top of the list', () => {
    expect(dropTargetParentId(items, null, 'new')).toBeNull();
  });

  it('joins the group of the child it was dropped after', () => {
    expect(dropTargetParentId(items, item('c1', { parentId: 'p1' }), 'new')).toBe('p1');
  });

  it('joins a top-level item that has children elsewhere in the list, not just an adjacent one', () => {
    expect(dropTargetParentId(items, item('p1'), 'new')).toBe('p1');
  });

  it('stays top-level when dropped after a genuinely childless top-level item', () => {
    expect(dropTargetParentId(items, item('p2'), 'new')).toBeNull();
  });
});

describe('applyCompletedCascade', () => {
  const group = () => [
    item('a'),
    item('a1', { parentId: 'a' }),
    item('a2', { parentId: 'a' }),
    item('b'),
  ];

  it('cascades a parent being checked to all of its children', () => {
    const result = applyCompletedCascade(group(), 'a', true);
    expect(result.map(it => it.completed)).toEqual([true, true, true, false]);
  });

  it('cascades a parent being unchecked to all of its children', () => {
    const checked = group().map(it => (it.id === 'b' ? it : { ...it, completed: true }));
    const result = applyCompletedCascade(checked, 'a', false);
    expect(result.map(it => it.completed)).toEqual([false, false, false, false]);
  });

  it('un-completes the parent when a child is unchecked', () => {
    const checked = group().map(it => ({ ...it, completed: true }));
    const result = applyCompletedCascade(checked, 'a1', false);
    expect(result.find(it => it.id === 'a')?.completed).toBe(false);
    expect(result.find(it => it.id === 'a1')?.completed).toBe(false);
    // The sibling child is untouched — only the unchecked item and its parent.
    expect(result.find(it => it.id === 'a2')?.completed).toBe(true);
  });

  it('does not auto-complete the parent when its last child is checked', () => {
    const items = group().map(it => (it.id === 'a2' ? { ...it, completed: true } : it));
    const result = applyCompletedCascade(items, 'a1', true);
    expect(result.find(it => it.id === 'a')?.completed).toBe(false);
  });

  it('returns the input unchanged for an unknown id', () => {
    const items = group();
    expect(applyCompletedCascade(items, 'nope', true)).toBe(items);
  });
});
