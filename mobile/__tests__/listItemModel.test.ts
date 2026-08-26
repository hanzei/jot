import type { NoteItem } from '@jot/shared';
import {
  type LocalItem,
  toLocalItems,
  serializeItems,
  itemSnapshot,
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
