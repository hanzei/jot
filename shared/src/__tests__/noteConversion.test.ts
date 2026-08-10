import { describe, it, expect } from 'vitest';
import { parseTextLineAsListItem, textToListNote, listToText } from '../noteConversion';
import { VALIDATION } from '../constants';
import type { NoteItem } from '../types';

/** Items only, for the many assertions that do not care about the title. */
function textToListItems(content: string) {
  return textToListNote(content).items;
}

/** text → list → text, as the two clients perform it end to end. */
function roundTripText(content: string): string {
  const note = textToListNote(content);
  return listToText(note.title, attachParents(note.items));
}

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

describe('textToListNote', () => {
  it('converts each non-blank line to an item, dropping blank lines', () => {
    const content = 'Groceries\n\n- [x] Milk\n- Eggs\n\n**Bread**';
    expect(textToListNote(content)).toEqual({
      title: '',
      items: [
        { text: 'Groceries', completed: false, indentLevel: 0 },
        { text: 'Milk', completed: true, indentLevel: 0 },
        { text: 'Eggs', completed: false, indentLevel: 0 },
        { text: '**Bread**', completed: false, indentLevel: 0 },
      ],
    });
  });

  it('carries nesting across', () => {
    expect(textToListItems('- Parent\n  - [x] Child\n- Second')).toEqual([
      { text: 'Parent', completed: false, indentLevel: 0 },
      { text: 'Child', completed: true, indentLevel: 1 },
      { text: 'Second', completed: false, indentLevel: 0 },
    ]);
  });

  it('returns an empty note for blank content', () => {
    expect(textToListNote('   \n\n  ')).toEqual({ title: '', items: [] });
  });

  it('promotes a leading heading to the title instead of an item', () => {
    expect(textToListNote('# Groceries\n\n- Milk')).toEqual({
      title: 'Groceries',
      items: [{ text: 'Milk', completed: false, indentLevel: 0 }],
    });
  });

  it('promotes any heading level, dropping the level itself', () => {
    for (const hashes of ['#', '##', '###', '####', '#####', '######']) {
      expect(textToListNote(`${hashes} Groceries\n- Milk`).title).toBe('Groceries');
    }
  });

  it('skips blank lines when looking for the heading', () => {
    expect(textToListNote('\n   \n## Groceries\n- Milk').title).toBe('Groceries');
  });

  it('promotes a heading that is the only line, leaving no items', () => {
    expect(textToListNote('# Groceries')).toEqual({ title: 'Groceries', items: [] });
  });

  it('only promotes the first heading; later ones stay items', () => {
    expect(textToListNote('# Groceries\n## Dairy\n- Milk')).toEqual({
      title: 'Groceries',
      items: [
        { text: 'Dairy', completed: false, indentLevel: 0 },
        { text: 'Milk', completed: false, indentLevel: 0 },
      ],
    });
  });

  it('does not promote a heading that is not the first non-blank line', () => {
    expect(textToListNote('- Milk\n# Groceries').title).toBe('');
  });

  // The `#` is nested inside another construct there, so it is not a heading
  // the user wrote as the note's title.
  it('does not promote a heading behind a blockquote or list marker', () => {
    expect(textToListNote('> # Groceries\n- Milk').title).toBe('');
    expect(textToListNote('- # Groceries\n- Milk').title).toBe('');
  });

  it('does not promote a setext heading', () => {
    const note = textToListNote('Groceries\n=====\n- Milk');
    expect(note.title).toBe('');
    expect(note.items[0]).toEqual({ text: 'Groceries', completed: false, indentLevel: 0 });
  });

  it('does not promote an empty heading, and drops the line as before', () => {
    expect(textToListNote('#\n- Milk')).toEqual({
      title: '',
      items: [
        { text: '#', completed: false, indentLevel: 0 },
        { text: 'Milk', completed: false, indentLevel: 0 },
      ],
    });
    expect(textToListNote('# \n- Milk')).toEqual({
      title: '',
      items: [{ text: 'Milk', completed: false, indentLevel: 0 }],
    });
  });

  // Truncating would drop text the note still holds; leaving the line alone
  // keeps every character and matches what conversion did before.
  it('leaves an over-long heading as an item rather than truncating it', () => {
    const long = 'x'.repeat(VALIDATION.TITLE_MAX_LENGTH + 1);
    expect(textToListNote(`# ${long}\n- Milk`)).toEqual({
      title: '',
      items: [
        { text: long, completed: false, indentLevel: 0 },
        { text: 'Milk', completed: false, indentLevel: 0 },
      ],
    });
  });

  it('promotes a heading of exactly the maximum title length', () => {
    const atLimit = 'x'.repeat(VALIDATION.TITLE_MAX_LENGTH);
    expect(textToListNote(`# ${atLimit}`).title).toBe(atLimit);
  });

  // The limit is the server's, and the server measures it in code points.
  it('measures the title limit in code points, not UTF-16 units', () => {
    const astral = '😀'.repeat(VALIDATION.TITLE_MAX_LENGTH);
    expect(textToListNote(`# ${astral}`).title).toBe(astral);
  });

  it('keeps inline formatting in a promoted title', () => {
    expect(textToListNote('# **Big** shop').title).toBe('**Big** shop');
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

  // The title is what makes this round trip lossless: it comes back as the
  // same `# h1` line it was written as, instead of arriving as an item and
  // leaving the note untitled.
  it('list → text → list preserves the title', () => {
    const items = [makeItem({ id: '1', text: 'Milk', position: 0 })];
    const text = listToText('Groceries', items);

    const note = textToListNote(text);
    expect(note.title).toBe('Groceries');
    expect(note.items).toEqual([{ text: 'Milk', completed: false, indentLevel: 0 }]);
    expect(listToText(note.title, attachParents(note.items))).toBe(text);
  });

  it('text → list → text preserves inline formatting', () => {
    const content = '- [ ] **Buy** `milk`\n- [x] ~~Cancelled~~ [link](https://example.com)';
    expect(roundTripText(content)).toBe(content);
  });

  // An item has one representation, so every way of writing a line collapses
  // onto it. Byte-identical content only comes back for content already in that
  // form, as the case above is.
  it('text → list → text normalizes every structural prefix to a task marker', () => {
    expect(roundTripText('* Eggs\n1. Milk\n> Bread')).toBe('- [ ] Eggs\n- [ ] Milk\n- [ ] Bread');
  });

  // The heading round-trips as a heading rather than collapsing onto an item,
  // and picks up the blank line listToText writes after a title.
  it('text → list → text returns a leading heading as an h1 title', () => {
    expect(roundTripText('## Groceries\n* Eggs')).toBe('# Groceries\n\n- [ ] Eggs');
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
