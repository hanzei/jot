import { describe, it, expect } from 'vitest';
import { parseTextLineAsListItem, textToListItems, listToText } from '../noteConversion';
import type { NoteItem } from '../types';

function makeItem(overrides: Partial<NoteItem> & { id: string; text: string }): NoteItem {
  return {
    note_id: 'n1',
    completed: false,
    position: 0,
    parent_id: null,
    assigned_to: '',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

/** Mirrors the server's buildCreateNoteItems, for the round-trip assertions. */
function attachParents(
  items: { text: string; completed: boolean; indentLevel: 0 | 1 }[],
): NoteItem[] {
  let lastTopLevelId: string | null = null;
  return items.map((item, index) => {
    const id = `i${index}`;
    const parentId = item.indentLevel === 1 ? lastTopLevelId : null;
    if (item.indentLevel === 0) lastTopLevelId = id;
    return makeItem({
      id,
      text: item.text,
      completed: item.completed,
      position: index,
      parent_id: parentId,
    });
  });
}

describe('parseTextLineAsListItem', () => {
  it('drops blank lines', () => {
    expect(parseTextLineAsListItem('')).toBeNull();
    expect(parseTextLineAsListItem('   ')).toBeNull();
  });

  it('drops a line that is only a list marker', () => {
    expect(parseTextLineAsListItem('- [ ] ')).toBeNull();
    expect(parseTextLineAsListItem('1. ')).toBeNull();
  });

  it('strips a heading prefix', () => {
    expect(parseTextLineAsListItem('# Groceries')).toEqual({ text: 'Groceries', completed: false, indentLevel: 0 });
    expect(parseTextLineAsListItem('### Sub heading')).toEqual({ text: 'Sub heading', completed: false, indentLevel: 0 });
  });

  it('strips blockquote markers', () => {
    expect(parseTextLineAsListItem('> Remember this')).toEqual({ text: 'Remember this', completed: false, indentLevel: 0 });
  });

  // The two nest in either order and the item replaces both, so neither may
  // survive into the item text — a leftover "- [x]" would render as a literal
  // checkbox beside the item's own.
  it('strips a blockquote and a list marker in either order', () => {
    expect(parseTextLineAsListItem('> - Child')).toEqual({ text: 'Child', completed: false, indentLevel: 0 });
    expect(parseTextLineAsListItem('> - [x] Child')).toEqual({ text: 'Child', completed: true, indentLevel: 0 });
    expect(parseTextLineAsListItem('- > Quoted')).toEqual({ text: 'Quoted', completed: false, indentLevel: 0 });
    expect(parseTextLineAsListItem('> - [ ] > Both')).toEqual({ text: 'Both', completed: false, indentLevel: 0 });
  });

  it('strips a leading list marker without setting completed', () => {
    expect(parseTextLineAsListItem('- Buy milk')).toEqual({ text: 'Buy milk', completed: false, indentLevel: 0 });
    expect(parseTextLineAsListItem('* Buy milk')).toEqual({ text: 'Buy milk', completed: false, indentLevel: 0 });
    expect(parseTextLineAsListItem('1. Buy milk')).toEqual({ text: 'Buy milk', completed: false, indentLevel: 0 });
  });

  it('recognizes a checkbox marker and sets completed', () => {
    expect(parseTextLineAsListItem('- [x] Buy milk')).toEqual({ text: 'Buy milk', completed: true, indentLevel: 0 });
    expect(parseTextLineAsListItem('- [X] Buy milk')).toEqual({ text: 'Buy milk', completed: true, indentLevel: 0 });
    expect(parseTextLineAsListItem('- [ ] Buy milk')).toEqual({ text: 'Buy milk', completed: false, indentLevel: 0 });
  });

  // The subset an item renders (docs/specs/markdown-rendering.md §2.1). Stripping
  // any of this would delete formatting the destination item displays.
  it('keeps inline formatting verbatim', () => {
    expect(parseTextLineAsListItem('**Buy** milk')?.text).toBe('**Buy** milk');
    expect(parseTextLineAsListItem('*Buy* milk')?.text).toBe('*Buy* milk');
    expect(parseTextLineAsListItem('__Buy__ milk')?.text).toBe('__Buy__ milk');
    expect(parseTextLineAsListItem('~~Buy~~ milk')?.text).toBe('~~Buy~~ milk');
    expect(parseTextLineAsListItem('Run `npm test`')?.text).toBe('Run `npm test`');
    expect(parseTextLineAsListItem('See [docs](https://example.com)')?.text).toBe('See [docs](https://example.com)');
  });

  it('keeps an intraword underscore and an emphasized one alike', () => {
    expect(parseTextLineAsListItem('Rename my_file_name.txt')?.text).toBe('Rename my_file_name.txt');
    expect(parseTextLineAsListItem('call __init__ here')?.text).toBe('call __init__ here');
  });

  // Block syntax that is not a line prefix renders as literal source in an item,
  // so it is kept rather than removed — including the image case, which the old
  // link-stripping regex mangled into a stray "!".
  it('keeps block syntax that the item renders literally', () => {
    expect(parseTextLineAsListItem('![alt](https://example.com/x.png)')?.text).toBe('![alt](https://example.com/x.png)');
    expect(parseTextLineAsListItem('```')?.text).toBe('```');
    expect(parseTextLineAsListItem('---')?.text).toBe('---');
    expect(parseTextLineAsListItem('| a | b |')?.text).toBe('| a | b |');
    expect(parseTextLineAsListItem('<b>bold</b>')?.text).toBe('<b>bold</b>');
  });

  it('strips the marker and keeps the inline formatting after it', () => {
    expect(parseTextLineAsListItem('- [x] **Buy** `milk`')).toEqual({
      text: '**Buy** `milk`',
      completed: true,
      indentLevel: 0,
    });
  });

  it('nests an indented list line', () => {
    expect(parseTextLineAsListItem('  - Child')).toEqual({ text: 'Child', completed: false, indentLevel: 1 });
    expect(parseTextLineAsListItem('    - [x] Deeper')).toEqual({ text: 'Deeper', completed: true, indentLevel: 1 });
    expect(parseTextLineAsListItem('\t- Tabbed')).toEqual({ text: 'Tabbed', completed: false, indentLevel: 1 });
  });

  it('caps nesting at one level, as the model allows', () => {
    expect(parseTextLineAsListItem('            - Very deep')?.indentLevel).toBe(1);
  });

  it('does not nest an indented line without a list marker', () => {
    expect(parseTextLineAsListItem('  a wrapped continuation')).toEqual({
      text: 'a wrapped continuation',
      completed: false,
      indentLevel: 0,
    });
  });

  it('does not nest a list line indented by less than two columns', () => {
    expect(parseTextLineAsListItem(' - Still top level')?.indentLevel).toBe(0);
  });
});

describe('textToListItems', () => {
  it('converts each non-blank line to an item, dropping blank lines', () => {
    const content = '# Groceries\n\n- [x] Milk\n- Eggs\n\n**Bread**';
    expect(textToListItems(content)).toEqual([
      { text: 'Groceries', completed: false, indentLevel: 0 },
      { text: 'Milk', completed: true, indentLevel: 0 },
      { text: 'Eggs', completed: false, indentLevel: 0 },
      { text: '**Bread**', completed: false, indentLevel: 0 },
    ]);
  });

  it('carries nesting across', () => {
    expect(textToListItems('- Parent\n  - [x] Child\n- Second')).toEqual([
      { text: 'Parent', completed: false, indentLevel: 0 },
      { text: 'Child', completed: true, indentLevel: 1 },
      { text: 'Second', completed: false, indentLevel: 0 },
    ]);
  });

  it('returns an empty array for blank content', () => {
    expect(textToListItems('   \n\n  ')).toEqual([]);
  });
});

describe('listToText', () => {
  it('renders the title as an h1 line followed by a blank line', () => {
    const items = [makeItem({ id: '1', text: 'Milk', position: 0 })];
    expect(listToText('Groceries', items)).toBe('# Groceries\n\n- [ ] Milk');
  });

  it('omits the heading entirely when there is no title', () => {
    const items = [makeItem({ id: '1', text: 'Milk', position: 0 })];
    expect(listToText('', items)).toBe('- [ ] Milk');
  });

  it('renders completed items with a checked box', () => {
    const items = [makeItem({ id: '1', text: 'Milk', completed: true, position: 0 })];
    expect(listToText('', items)).toBe('- [x] Milk');
  });

  it('orders top-level items by position and indents nested children under their parent', () => {
    const items = [
      makeItem({ id: 'p2', text: 'Second parent', position: 1 }),
      makeItem({ id: 'p1', text: 'First parent', position: 0 }),
      makeItem({ id: 'c1', text: 'Child of first', position: 0, parent_id: 'p1' }),
      makeItem({ id: 'c2', text: 'Another child of first', position: 1, parent_id: 'p1' }),
    ];
    expect(listToText('', items)).toBe(
      '- [ ] First parent\n  - [ ] Child of first\n  - [ ] Another child of first\n- [ ] Second parent',
    );
  });

  // Items render the inline subset themselves, so escaping would change what the
  // user sees rather than preserve it.
  it('emits item text verbatim, without escaping markdown', () => {
    const items = [
      makeItem({ id: '1', text: '2 * 3 * 4', position: 0 }),
      makeItem({ id: '2', text: '**already bold**', position: 1 }),
      makeItem({ id: '3', text: '# not a heading', position: 2 }),
    ];
    expect(listToText('', items)).toBe('- [ ] 2 * 3 * 4\n- [ ] **already bold**\n- [ ] # not a heading');
  });
});

describe('round trips', () => {
  it('list → text → list preserves text, completed state and nesting', () => {
    const items = [
      makeItem({ id: 'p1', text: 'First parent', position: 0 }),
      makeItem({ id: 'c1', text: '**Child** of first', position: 0, parent_id: 'p1', completed: true }),
      makeItem({ id: 'p2', text: 'Second parent', completed: true, position: 1 }),
    ];

    expect(textToListItems(listToText('', items))).toEqual([
      { text: 'First parent', completed: false, indentLevel: 0 },
      { text: '**Child** of first', completed: true, indentLevel: 1 },
      { text: 'Second parent', completed: true, indentLevel: 0 },
    ]);
  });

  it('list → text → list is stable once the server has rebuilt parent_id', () => {
    const original = [
      makeItem({ id: 'i0', text: 'Parent', position: 0 }),
      makeItem({ id: 'i1', text: 'Child', position: 1, parent_id: 'i0' }),
      makeItem({ id: 'i2', text: 'After', position: 2 }),
    ];

    const first = listToText('', original);
    const second = listToText('', attachParents(textToListItems(first)));
    expect(second).toBe(first);
  });

  it('text → list → text preserves inline formatting', () => {
    const content = '- [ ] **Buy** `milk`\n- [x] ~~Cancelled~~ [link](https://example.com)';
    expect(listToText('', attachParents(textToListItems(content)))).toBe(content);
  });

  // An item has one representation, so every way of writing a line collapses
  // onto it. Byte-identical content only comes back for content already in that
  // form, as the case above is.
  it('text → list → text normalizes every structural prefix to a task marker', () => {
    const content = '# Groceries\n* Eggs\n1. Milk\n> Bread';
    expect(listToText('', attachParents(textToListItems(content)))).toBe(
      '- [ ] Groceries\n- [ ] Eggs\n- [ ] Milk\n- [ ] Bread',
    );
  });

  // The converter cannot tell a leading block marker in item text apart from the
  // block markup it exists to strip, so this one case does not survive.
  it('loses a leading block marker in item text on the way back', () => {
    const items = [
      makeItem({ id: '1', text: '# not a heading', position: 0 }),
      makeItem({ id: '2', text: '> not a quote', position: 1 }),
      makeItem({ id: '3', text: '- [x] not a checkbox', position: 2 }),
    ];

    expect(textToListItems(listToText('', items)).map((item) => item.text)).toEqual([
      'not a heading',
      'not a quote',
      // A second marker survives: the first one consumed the item's own.
      '- [x] not a checkbox',
    ]);
  });

  it('leaves an indented first line top-level, matching the server', () => {
    // indent_level 1 with no preceding top-level item resolves to no parent.
    const items = attachParents(textToListItems('  - Orphan\n- Parent'));
    expect(items[0]!.parent_id).toBeNull();
    expect(listToText('', items)).toBe('- [ ] Orphan\n- [ ] Parent');
  });
});
