import { describe, it, expect } from 'vitest';
import {
  applyCompletedCascade,
  dropTargetParentId,
  indentOf,
  itemHasChildren,
  normalizeItemOrder,
  precedingTopLevelId,
  type ListItem,
} from '../noteItems';

// Terse builder so each case reads as the structure under test rather than as
// six fields of boilerplate per item.
const item = (
  id: string,
  overrides: Partial<Omit<ListItem, 'id'>> = {},
): ListItem => ({
  id,
  text: id,
  completed: false,
  position: 0,
  parentId: null,
  assignedTo: '',
  ...overrides,
});

const ids = (items: ListItem[]) => items.map(it => it.id);
const parents = (items: ListItem[]) => items.map(it => it.parentId);

describe('indentOf', () => {
  it('reports 0 for a top-level item and 1 for a nested one', () => {
    expect(indentOf({ parentId: null })).toBe(0);
    expect(indentOf({ parentId: 'a' })).toBe(1);
  });
});

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
    expect(input[0].position).toBe(99);
    expect(result[0].position).toBe(0);
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

describe('precedingTopLevelId', () => {
  it('returns the nearest preceding top-level item', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(precedingTopLevelId(items, 'c')).toBe('b');
  });

  it('skips over children when looking backwards', () => {
    const items = [item('a'), item('a1', { parentId: 'a' }), item('b')];
    expect(precedingTopLevelId(items, 'b')).toBe('a');
  });

  it('returns null for the first item, with nothing to nest under', () => {
    expect(precedingTopLevelId([item('a'), item('b')], 'a')).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(precedingTopLevelId([item('a')], 'nope')).toBeNull();
  });
});

describe('dropTargetParentId', () => {
  it('keeps an item with children top-level, since it cannot become a child', () => {
    const items = [item('b'), item('a'), item('a1', { parentId: 'a' })];
    expect(dropTargetParentId(items, 1, 'a')).toBeNull();
  });

  it('returns null when dropped at the very top of the list', () => {
    const items = [item('c'), item('a'), item('b')];
    expect(dropTargetParentId(items, 0, 'c')).toBeNull();
  });

  it('joins the group of the child it was dropped after', () => {
    const items = [item('a'), item('a1', { parentId: 'a' }), item('c')];
    expect(dropTargetParentId(items, 2, 'c')).toBe('a');
  });

  it('becomes the first child when dropped between a parent and its first child', () => {
    const items = [item('a'), item('c'), item('a1', { parentId: 'a' })];
    expect(dropTargetParentId(items, 1, 'c')).toBe('a');
  });

  it('stays top-level when dropped after a childless top-level item', () => {
    const items = [item('a'), item('c'), item('b')];
    expect(dropTargetParentId(items, 1, 'c')).toBeNull();
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
