import type { NoteItem } from '@jot/shared';
import {
  type LocalItem,
  toLocalItems,
  serializeItems,
  itemSnapshot,
  normalizeItemOrder,
  itemHasChildren,
  applyCompletedCascade,
  droppedParentId,
  indentLevelFromDrag,
} from '../src/screens/noteEditor/listItemModel';
import { VALIDATION } from '@jot/shared';

const STEP = VALIDATION.INDENT_PX_PER_LEVEL;

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
    expect(result[1]!.parentId).toBe('a');
  });

  it('defaults missing assigned_to/parent_id', () => {
    const item = toLocalItems([server({ id: 'a', parent_id: null })])[0]!;
    expect(item.parentId).toBeNull();
    expect(item.assigned_to).toBe('');
  });
});

describe('indentLevelFromDrag', () => {
  it('snaps a rightward drag of one step to the next indent level', () => {
    expect(indentLevelFromDrag(STEP, 0, true, false)).toBe(1);
    // Rounds at the half-step boundary.
    expect(indentLevelFromDrag(STEP * 0.6, 0, true, false)).toBe(1);
    expect(indentLevelFromDrag(STEP * 0.4, 0, true, false)).toBe(0);
  });

  it('snaps a leftward drag back to top-level when nested', () => {
    expect(indentLevelFromDrag(-STEP, 1, false, true)).toBe(0);
    expect(indentLevelFromDrag(-STEP * 0.6, 1, false, true)).toBe(0);
  });

  it('clamps to the one-level hierarchy [0, 1]', () => {
    expect(indentLevelFromDrag(STEP * 5, 0, true, false)).toBe(1);
    expect(indentLevelFromDrag(-STEP * 5, 1, false, true)).toBe(0);
  });

  it('refuses to indent when the item may not be nested (has children / no row above)', () => {
    expect(indentLevelFromDrag(STEP * 3, 0, false, false)).toBe(0);
  });

  it('refuses to outdent when the item is already top-level', () => {
    expect(indentLevelFromDrag(-STEP * 3, 0, true, false)).toBe(0);
  });

  it('keeps the base level when the drag is too small to cross a step', () => {
    expect(indentLevelFromDrag(0, 0, true, false)).toBe(0);
    expect(indentLevelFromDrag(STEP * 0.3, 1, true, true)).toBe(1);
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
    expect(result[0]!.parentId).toBeNull();
  });
});

describe('itemHasChildren', () => {
  const items = [
    local({ id: 'p1' }),
    local({ id: 'c1', parentId: 'p1' }),
    local({ id: 'p2' }),
  ];

  it('detects children', () => {
    expect(itemHasChildren(items, 'p1')).toBe(true);
    expect(itemHasChildren(items, 'p2')).toBe(false);
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

  it('unchecking a child also un-completes an already-completed parent', () => {
    const completedGroup = [
      local({ id: 'p1', completed: true }),
      local({ id: 'c1', parentId: 'p1', completed: true }),
      local({ id: 'c2', parentId: 'p1', completed: true }),
    ];
    const result = applyCompletedCascade(completedGroup, 'c1', false);
    expect(result.find((i) => i.id === 'c1')?.completed).toBe(false);
    expect(result.find((i) => i.id === 'p1')?.completed).toBe(false);
    expect(result.find((i) => i.id === 'c2')?.completed).toBe(true);
  });

  it('completing every child does not auto-complete the parent', () => {
    const group = [
      local({ id: 'p1' }),
      local({ id: 'c1', parentId: 'p1', completed: true }),
      local({ id: 'c2', parentId: 'p1' }),
    ];
    const result = applyCompletedCascade(group, 'c2', true);
    expect(result.find((i) => i.id === 'c2')?.completed).toBe(true);
    expect(result.find((i) => i.id === 'p1')?.completed).toBe(false);
  });
});

describe('droppedParentId', () => {
  // Groups: p1 (with child c1) and p2 (with child c2), plus a top-level leaf t.
  const items = [
    local({ id: 'p1' }),
    local({ id: 'c1', parentId: 'p1' }),
    local({ id: 'p2' }),
    local({ id: 'c2', parentId: 'p2' }),
    local({ id: 't' }),
  ];

  it('keeps an item with children top-level (cannot nest a parent)', () => {
    expect(droppedParentId(items, local({ id: 'p1' }), local({ id: 'c2', parentId: 'p2' }))).toBeNull();
  });

  it('is top-level when dropped at the very top (no row above)', () => {
    expect(droppedParentId(items, local({ id: 't' }), null)).toBeNull();
  });

  it('joins the same parent as a child row above it', () => {
    expect(droppedParentId(items, local({ id: 't' }), local({ id: 'c2', parentId: 'p2' }))).toBe('p2');
  });

  it('becomes a child when dropped right under a group head', () => {
    expect(droppedParentId(items, local({ id: 't' }), local({ id: 'p1' }))).toBe('p1');
  });

  it('stays top-level when the row above is a top-level leaf', () => {
    expect(droppedParentId(items, local({ id: 't' }), local({ id: 'solo' }))).toBeNull();
  });
});
