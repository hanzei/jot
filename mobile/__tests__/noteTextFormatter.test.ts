import { formatEditorStateForShare, formatNoteForShare } from '../src/utils/noteTextFormatter';
import type { Note, NoteItem } from '@jot/shared';
import type { LocalItem } from '../src/screens/noteEditor/listItemModel';

const baseNote = {
  id: 'n1',
  user_id: 'u1',
  version: 1,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  is_shared: false,
  shared_with: [],
  labels: [],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function makeTextNote(content: string): Note {
  return { ...baseNote, note_type: 'text', content };
}

function makeListNote(title: string, items: NoteItem[] = []): Note {
  return {
    ...baseNote,
    note_type: 'list',
    title,
    checked_items_collapsed: false,
    items,
  };
}

function makeItem(id: string, text: string, completed: boolean, parent_id: string | null = null, position = 0) {
  return {
    id,
    note_id: 'n1',
    text,
    completed,
    position,
    parent_id,
    assigned_to: '',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

function makeLocalItem(id: string, text: string, completed: boolean, parentId: string | null = null, position = 0): LocalItem {
  return { id, text, completed, position, parentId, assigned_to: '' };
}

// ─── formatNoteForShare ────────────────────────────────────────────────────

describe('formatNoteForShare — text notes', () => {
  it('returns plain content unchanged', () => {
    expect(formatNoteForShare(makeTextNote('Hello world'))).toBe('Hello world');
  });

  it('strips bold markdown', () => {
    expect(formatNoteForShare(makeTextNote('**bold** text'))).toBe('bold text');
  });

  it('strips italic markdown', () => {
    expect(formatNoteForShare(makeTextNote('*italic* and _also_'))).toBe('italic and also');
  });

  it('strips heading markers', () => {
    expect(formatNoteForShare(makeTextNote('## Heading\nBody text'))).toBe('Heading\nBody text');
  });

  it('strips bullet list markers', () => {
    expect(formatNoteForShare(makeTextNote('- item one\n- item two'))).toBe('item one\nitem two');
  });

  it('strips inline code backticks', () => {
    expect(formatNoteForShare(makeTextNote('use `code` here'))).toBe('use code here');
  });

  it('returns empty string for empty content', () => {
    expect(formatNoteForShare(makeTextNote(''))).toBe('');
  });
});

describe('formatNoteForShare — list notes', () => {
  it('formats uncompleted items with [ ]', () => {
    const note = makeListNote('My List', [makeItem('i1', 'Buy milk', false, null, 0)]);
    expect(formatNoteForShare(note)).toBe('My List\n\n[ ] Buy milk');
  });

  it('formats completed items with [x]', () => {
    const note = makeListNote('Tasks', [makeItem('i1', 'Done thing', true, null, 0)]);
    expect(formatNoteForShare(note)).toBe('Tasks\n\n[x] Done thing');
  });

  it('indents nested items', () => {
    const note = makeListNote('', [
      makeItem('i1', 'Parent', false, null, 0),
      makeItem('i2', 'Child', true, 'i1', 1),
    ]);
    expect(formatNoteForShare(note)).toBe('[ ] Parent\n  [x] Child');
  });

  it('omits title when blank', () => {
    const note = makeListNote('', [makeItem('i1', 'Item', false, null, 0)]);
    expect(formatNoteForShare(note)).toBe('[ ] Item');
  });

  it('returns empty string for empty list note', () => {
    expect(formatNoteForShare(makeListNote('', []))).toBe('');
  });

  it('returns just the title when there are no items', () => {
    expect(formatNoteForShare(makeListNote('Just a title', []))).toBe('Just a title');
  });
});

// ─── formatEditorStateForShare ─────────────────────────────────────────────

describe('formatEditorStateForShare — text notes', () => {
  it('strips markdown from content', () => {
    expect(formatEditorStateForShare('text', '', '**hello**', [])).toBe('hello');
  });

  it('ignores title for text notes', () => {
    expect(formatEditorStateForShare('text', 'ignored title', 'content', [])).toBe('content');
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
});
