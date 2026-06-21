import type { NoteItem } from '@jot/shared';
import {
  type LocalItem,
  toLocalItems,
  serializeItems,
  itemSnapshot,
  normalizeItemOrder,
  itemHasChildren,
  precedingTopLevelId,
  applyCompletedCascade,
} from '../src/screens/noteEditor/listItemModel';

function local(partial: Partial<LocalItem> & { id: string }): LocalItem {
  return {
    text: '',
    completed: false,
    position: 0,
    parentId: null,
    assigned_to: '',
    ...partial,
  };
}

function server(partial: Partial<NoteItem> & { id: string }): NoteItem {
  return {
    note_id: 'n1',
    text: '',
    completed: false,
    position: 0,
    parent_id: null,
    assigned_to: '',
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

describe('toLocalItems', () => {
  it('sorts by position and maps parent_id → parentId', () => {
    const result = toLocalItems([
      server({ id: 'b', position: 1, parent_id: 'a' }),
      server({ id: 'a', position: 0 }),
    ]);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result[1].parentId).toBe('a');
  });

  it('defaults missing assigned_to/parent_id', () => {
    const [item] = toLocalItems([server({ id: 'a', parent_id: null })]);
    expect(item.parentId).toBeNull();
    expect(item.assigned_to).toBe('');
  });
});

describe('serializeItems', () => {
  it('renumbers position by array index and encodes nesting as indent_level', () => {
    const result = serializeItems([
      local({ id: 'a', position: 5 }),
      local({ id: 'b', position: 9, parentId: 'a' }),
    ]);
    expect(result).toEqual([
      { id: 'a', text: '', position: 0, completed: false, indent_level: 0, assigned_to: '' },
      { id: 'b', text: '', position: 1, completed: false, indent_level: 1, assigned_to: '' },
    ]);
  });
});

describe('itemSnapshot', () => {
  it('captures only the mergeable fields', () => {
    expect(itemSnapshot(local({ id: 'a', text: 'x', completed: true, parentId: 'p', assigned_to: 'u', position: 3 }))).toEqual({
      text: 'x',
      completed: true,
      parentId: 'p',
      assigned_to: 'u',
    });
  });
});

describe('normalizeItemOrder', () => {
  it('keeps each parent followed by its children and renumbers positions', () => {
    const result = normalizeItemOrder([
      local({ id: 'p1' }),
      local({ id: 'p2' }),
      local({ id: 'c1', parentId: 'p1' }),
    ]);
    expect(result.map((i) => i.id)).toEqual(['p1', 'c1', 'p2']);
    expect(result.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it('promotes orphaned children (missing parent) to top level', () => {
    const result = normalizeItemOrder([local({ id: 'c1', parentId: 'gone' })]);
    expect(result[0].parentId).toBeNull();
  });
});

describe('itemHasChildren / precedingTopLevelId', () => {
  const items = [
    local({ id: 'p1' }),
    local({ id: 'c1', parentId: 'p1' }),
    local({ id: 'p2' }),
  ];

  it('detects children', () => {
    expect(itemHasChildren(items, 'p1')).toBe(true);
    expect(itemHasChildren(items, 'p2')).toBe(false);
  });

  it('finds the nearest preceding top-level item', () => {
    expect(precedingTopLevelId(items, 'p2')).toBe('p1');
    expect(precedingTopLevelId(items, 'p1')).toBeNull();
  });
});

describe('applyCompletedCascade', () => {
  // This mirrors collectToggleCascade in hooks/useNotes.ts — keep them in sync.
  const items = [
    local({ id: 'p1' }),
    local({ id: 'c1', parentId: 'p1' }),
    local({ id: 'c2', parentId: 'p1' }),
    local({ id: 'p2' }),
  ];

  it('toggling a top-level item cascades to its children', () => {
    const result = applyCompletedCascade(items, 'p1', true);
    expect(result.filter((i) => i.completed).map((i) => i.id)).toEqual(['p1', 'c1', 'c2']);
  });

  it('toggling a child touches only that child', () => {
    const result = applyCompletedCascade(items, 'c1', true);
    expect(result.filter((i) => i.completed).map((i) => i.id)).toEqual(['c1']);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(applyCompletedCascade(items, 'missing', true)).toBe(items);
  });
});
