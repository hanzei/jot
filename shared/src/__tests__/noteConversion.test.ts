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

describe('parseTextLineAsListItem', () => {
  it('drops blank lines', () => {
    expect(parseTextLineAsListItem('')).toBeNull();
    expect(parseTextLineAsListItem('   ')).toBeNull();
  });

  it('strips heading markdown', () => {
    expect(parseTextLineAsListItem('# Groceries')).toEqual({ text: 'Groceries', completed: false });
    expect(parseTextLineAsListItem('### Sub heading')).toEqual({ text: 'Sub heading', completed: false });
  });

  it('strips bold and italic markdown', () => {
    expect(parseTextLineAsListItem('**Buy** milk')).toEqual({ text: 'Buy milk', completed: false });
    expect(parseTextLineAsListItem('__Buy__ milk')).toEqual({ text: 'Buy milk', completed: false });
    expect(parseTextLineAsListItem('*Buy* milk')).toEqual({ text: 'Buy milk', completed: false });
  });

  it('strips inline code and links', () => {
    expect(parseTextLineAsListItem('Run `npm test`')).toEqual({ text: 'Run npm test', completed: false });
    expect(parseTextLineAsListItem('See [docs](https://example.com)')).toEqual({ text: 'See docs', completed: false });
  });

  it('strips blockquote markers', () => {
    expect(parseTextLineAsListItem('> Remember this')).toEqual({ text: 'Remember this', completed: false });
  });

  it('strips a leading list marker without setting completed', () => {
    expect(parseTextLineAsListItem('- Buy milk')).toEqual({ text: 'Buy milk', completed: false });
    expect(parseTextLineAsListItem('* Buy milk')).toEqual({ text: 'Buy milk', completed: false });
    expect(parseTextLineAsListItem('1. Buy milk')).toEqual({ text: 'Buy milk', completed: false });
  });

  it('recognizes a checkbox marker and sets completed', () => {
    expect(parseTextLineAsListItem('- [x] Buy milk')).toEqual({ text: 'Buy milk', completed: true });
    expect(parseTextLineAsListItem('- [X] Buy milk')).toEqual({ text: 'Buy milk', completed: true });
    expect(parseTextLineAsListItem('- [ ] Buy milk')).toEqual({ text: 'Buy milk', completed: false });
  });

  it('combines marker stripping with inline formatting', () => {
    expect(parseTextLineAsListItem('- [x] **Buy** `milk`')).toEqual({ text: 'Buy milk', completed: true });
  });
});

describe('textToListItems', () => {
  it('converts each non-blank line to an item, dropping blank lines', () => {
    const content = '# Groceries\n\n- [x] Milk\n- Eggs\n\n**Bread**';
    expect(textToListItems(content)).toEqual([
      { text: 'Groceries', completed: false },
      { text: 'Milk', completed: true },
      { text: 'Eggs', completed: false },
      { text: 'Bread', completed: false },
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
});
