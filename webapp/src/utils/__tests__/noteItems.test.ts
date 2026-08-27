import { describe, it, expect } from 'vitest';
import { indentOf, precedingTopLevelId } from '../noteItems';
import type { ListItem } from '@jot/shared';

// Terse builder so each case reads as the structure under test rather than as
// six fields of boilerplate per item. The ordering/cascade/drop-target rules
// themselves are tested once, in shared/src/__tests__/listItems.test.ts.
const item = (
  id: string,
  overrides: Partial<Omit<ListItem, 'id'>> = {},
): ListItem => ({
  id,
  text: id,
  completed: false,
  position: 0,
  parentId: null,
  assigned_to: '',
  ...overrides,
});

describe('indentOf', () => {
  it('reports 0 for a top-level item and 1 for a nested one', () => {
    expect(indentOf({ parentId: null })).toBe(0);
    expect(indentOf({ parentId: 'a' })).toBe(1);
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
