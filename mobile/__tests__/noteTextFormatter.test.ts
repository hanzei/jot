import { formatEditorStateForShare } from '../src/utils/noteTextFormatter';
import type { LocalItem } from '../src/screens/noteEditor/listItemModel';

// The renderers themselves are covered in shared (`blockNodesToPlainText`,
// `listToPlainText`); these pin the wiring from editor state and the output a
// user sees in the share sheet.

function makeLocalItem(id: string, text: string, completed: boolean, parentId: string | null = null, position = 0): LocalItem {
  return { id, text, completed, position, parentId, assigned_to: '' };
}

describe('formatEditorStateForShare — text notes', () => {
  it('returns plain content unchanged', () => {
    expect(formatEditorStateForShare('text', '', 'Hello world', [])).toBe('Hello world');
  });

  it('strips inline markdown from content', () => {
    expect(formatEditorStateForShare('text', '', '**hello** *there* `code`', [])).toBe('hello there code');
  });

  it('keeps snake_case identifiers intact', () => {
    expect(formatEditorStateForShare('text', '', 'set my_var_name and snake_case', [])).toBe(
      'set my_var_name and snake_case',
    );
  });

  it('strips heading markers', () => {
    expect(formatEditorStateForShare('text', '', '## Heading\n\nBody text', [])).toBe('Heading\n\nBody text');
  });

  it('keeps list structure', () => {
    expect(formatEditorStateForShare('text', '', '- item one\n- item two', [])).toBe('- item one\n- item two');
  });

  it('ignores title for text notes', () => {
    expect(formatEditorStateForShare('text', 'ignored title', 'content', [])).toBe('content');
  });

  it('returns empty string for empty content', () => {
    expect(formatEditorStateForShare('text', '', '', [])).toBe('');
  });
});

describe('formatEditorStateForShare — list notes', () => {
  it('combines title and items', () => {
    const items: LocalItem[] = [makeLocalItem('i1', 'Do laundry', false)];
    expect(formatEditorStateForShare('list', 'Chores', '', items)).toBe('Chores\n\n[ ] Do laundry');
  });

  it('marks completed local items with [x]', () => {
    const items: LocalItem[] = [makeLocalItem('i1', 'Done', true)];
    expect(formatEditorStateForShare('list', '', '', items)).toBe('[x] Done');
  });

  it('indents nested local items', () => {
    const items: LocalItem[] = [
      makeLocalItem('i1', 'Top', false, null, 0),
      makeLocalItem('i2', 'Sub', false, 'i1', 1),
    ];
    expect(formatEditorStateForShare('list', '', '', items)).toBe('[ ] Top\n  [ ] Sub');
  });

  it('respects position when input items are out of order', () => {
    const items: LocalItem[] = [
      makeLocalItem('i3', 'Third', false, null, 2),
      makeLocalItem('i1', 'First', false, null, 0),
      makeLocalItem('i2', 'Second', true, null, 1),
    ];
    expect(formatEditorStateForShare('list', '', '', items)).toBe(
      '[ ] First\n[x] Second\n[ ] Third',
    );
  });

  it('returns just the title when there are no items, and nothing for an empty note', () => {
    expect(formatEditorStateForShare('list', 'Just a title', '', [])).toBe('Just a title');
    expect(formatEditorStateForShare('list', '', '', [])).toBe('');
  });
});
