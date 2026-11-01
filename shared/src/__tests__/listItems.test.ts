import { describe, it, expect } from 'vitest';
import { applyCompletedCascade, applyCompletedValues, completedCascadeScope, completedPriorById, dropTargetParentId, groupNoteItems, itemHasChildren, moveItemIntoSlot, normalizeItemOrder, undoMoveItemIntoSlot, type ListItem } from '../listItems';

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

describe('moveItemIntoSlot', () => {
  const byId = (items: ListItem[], id: string) => items.find(it => it.id === id)!;

  it('replaces the slot row with the moved item and renumbers', () => {
    const result = moveItemIntoSlot([
      item('a'),
      item('typing', { text: 'mil' }),
      item('b'),
      item('milk', { completed: true }),
    ], 'typing', 'milk');
    expect(ids(result)).toEqual(['a', 'milk', 'b']);
    expect(result.map(it => it.position)).toEqual([0, 1, 2]);
  });

  it('leaves the completed flag alone; unchecking is the toggle path\'s job', () => {
    const result = moveItemIntoSlot([
      item('typing'),
      item('p', { completed: true }),
      item('p1', { parentId: 'p', completed: true }),
    ], 'typing', 'p1');
    expect(result.map(it => it.completed)).toEqual([true, true]);
  });

  it('takes the slot even when the moved item sat above it', () => {
    const result = moveItemIntoSlot([
      item('milk', { completed: true }),
      item('a'),
      item('b'),
      item('typing'),
      item('c'),
    ], 'typing', 'milk');
    expect(ids(result)).toEqual(['a', 'b', 'milk', 'c']);
  });

  it('keeps a moved child in its own group, ignoring the slot row\'s indent', () => {
    const result = moveItemIntoSlot([
      item('a'),
      item('typing', { parentId: 'a' }),
      item('b'),
      item('b1', { parentId: 'b', completed: true }),
    ], 'typing', 'b1');
    expect(ids(result)).toEqual(['a', 'b', 'b1']);
    expect(byId(result, 'b1').parentId).toBe('b');
  });

  it('keeps a moved top-level item at top level when the slot row was indented', () => {
    const result = moveItemIntoSlot([
      item('a'),
      item('typing', { parentId: 'a' }),
      item('milk', { completed: true }),
    ], 'typing', 'milk');
    expect(byId(result, 'milk').parentId).toBeNull();
  });

  it('promotes the children of a slot row that was a parent', () => {
    const result = moveItemIntoSlot([
      item('typing'),
      item('t1', { parentId: 'typing' }),
      item('milk', { completed: true }),
    ], 'typing', 'milk');
    expect(ids(result)).toEqual(['milk', 't1']);
    expect(parents(result)).toEqual([null, null]);
  });

  it('returns the input unchanged for an unknown item id', () => {
    const items = [item('typing'), item('milk', { completed: true })];
    expect(moveItemIntoSlot(items, 'typing', 'nope')).toBe(items);
  });
});

describe('undoMoveItemIntoSlot', () => {
  const original = () => [
    item('a'),
    item('typing', { text: 'mil' }),
    item('b'),
    item('milk', { completed: true }),
  ];

  it('restores the list the move started from', () => {
    const before = original();
    const moved = moveItemIntoSlot(before, 'typing', 'milk');
    const undone = undoMoveItemIntoSlot(moved, before, before[1]!, 'milk');
    expect(ids(undone)).toEqual(['a', 'typing', 'b', 'milk']);
    expect(undone.find(it => it.id === 'typing')?.text).toBe('mil');
  });

  it('puts a child back in its group and the typed row back in its own place', () => {
    const before = [
      item('a'),
      item('typing'),
      item('p'),
      item('p1', { parentId: 'p', completed: true }),
    ];
    const moved = moveItemIntoSlot(before, 'typing', 'p1');
    const undone = undoMoveItemIntoSlot(moved, before, before[1]!, 'p1');
    expect(ids(undone)).toEqual(['a', 'typing', 'p', 'p1']);
  });

  it('keeps edits made to the moved item meanwhile', () => {
    const before = original();
    const moved = moveItemIntoSlot(before, 'typing', 'milk')
      .map(it => (it.id === 'milk' ? { ...it, text: 'Milk 2L' } : it));
    const undone = undoMoveItemIntoSlot(moved, before, before[1]!, 'milk');
    expect(undone.find(it => it.id === 'milk')?.text).toBe('Milk 2L');
  });

  it('returns the input unchanged when the slot row is already present', () => {
    const before = original();
    expect(undoMoveItemIntoSlot(before, before, before[1]!, 'milk')).toBe(before);
  });
});

describe('groupNoteItems', () => {
  const noteItem = (id: string, position: number, parent_id: string | null = null) => ({ id, position, parent_id });
  const idsOf = (items: { id: string }[]) => items.map(it => it.id);

  it('places a child whose position sorts ahead of its parent under that parent', () => {
    // The shopping-list report: Bandnudeln (a child of Trockenwaren) had the
    // lower position and rendered above its parent on the card.
    const result = groupNoteItems([
      noteItem('bandnudeln', 0, 'trockenwaren'),
      noteItem('trockenwaren', 1),
    ]);
    expect(idsOf(result)).toEqual(['trockenwaren', 'bandnudeln']);
  });

  it('orders by position and keeps children in their own position order', () => {
    const result = groupNoteItems([
      noteItem('b', 3),
      noteItem('a2', 4, 'a'),
      noteItem('a', 1),
      noteItem('a1', 0, 'a'),
    ]);
    expect(idsOf(result)).toEqual(['a', 'a1', 'a2', 'b']);
  });

  it('keeps items sharing a position in arrival order', () => {
    expect(idsOf(groupNoteItems([noteItem('x', 0), noteItem('y', 0)]))).toEqual(['x', 'y']);
  });

  it('leaves a child of a missing parent in its own place without re-parenting it', () => {
    const orphan = noteItem('orphan', 1, 'gone');
    const result = groupNoteItems([noteItem('a', 0), orphan, noteItem('b', 2)]);
    expect(idsOf(result)).toEqual(['a', 'orphan', 'b']);
    expect(result[1]).toBe(orphan);
  });

  it('does not mutate its input', () => {
    const input = [noteItem('a1', 0, 'a'), noteItem('a', 1)];
    groupNoteItems(input);
    expect(idsOf(input)).toEqual(['a1', 'a']);
  });
});

describe('completedCascadeScope', () => {
  const items = [
    { id: 'p', parentId: null },
    { id: 'c1', parentId: 'p' },
    { id: 'c2', parentId: 'p' },
    { id: 'solo', parentId: null },
  ];

  it('covers a top-level item and all of its children, in either direction', () => {
    expect(completedCascadeScope(items, 'p', true)).toEqual(['p', 'c1', 'c2']);
    expect(completedCascadeScope(items, 'p', false)).toEqual(['p', 'c1', 'c2']);
  });

  it('covers a child alone when checked, and its parent too when unchecked', () => {
    expect(completedCascadeScope(items, 'c1', true)).toEqual(['c1']);
    expect(completedCascadeScope(items, 'c1', false)).toEqual(['c1', 'p']);
  });

  it('is empty for an unknown item', () => {
    expect(completedCascadeScope(items, 'missing', true)).toEqual([]);
  });
});

describe('completedPriorById', () => {
  it('maps only the ids whose value would change to their current value', () => {
    const items = [item('a', { completed: false }), item('b', { completed: true }), item('c', { completed: false })];
    expect(completedPriorById(items, ['a', 'b'], true)).toEqual(new Map([['a', false]]));
  });
});

describe('applyCompletedValues', () => {
  it('sets the given completed flags and keeps every other item as it is', () => {
    const items = [item('a'), item('b')];
    const next = applyCompletedValues(items, new Map([['a', true]]));
    expect(next.map(it => it.completed)).toEqual([true, false]);
    expect(next[1]).toBe(items[1]);
  });

  it('returns the same array when no value changes', () => {
    const items = [item('a', { completed: true })];
    expect(applyCompletedValues(items, new Map([['a', true], ['missing', false]]))).toBe(items);
  });
});
