import type { Note, TextNote } from '@jot/shared';
import { buildNoteSections } from '../src/screens/notesList/noteListUtils';

const BASE_NOTE = {
  user_id: 'user-1',
  version: 1,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  is_shared: false,
  labels: [] as never[],
  shared_with: [] as never[],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function buildTextNote(overrides: Partial<TextNote> & { id: string }): TextNote {
  return { ...BASE_NOTE, note_type: 'text', content: 'content', ...overrides };
}

const t = (key: string) => key;

describe('buildNoteSections', () => {
  const note1: Note = buildTextNote({ id: 'n1' });
  const note2: Note = buildTextNote({ id: 'n2' });
  const note3: Note = buildTextNote({ id: 'n3' });

  it('returns empty array when all groups are empty', () => {
    expect(buildNoteSections([], [], [], true, t)).toEqual([]);
  });

  it('includes a pinned section only when includePinned is true and pinned is non-empty', () => {
    const sections = buildNoteSections([note1], [note2], [], true, t);
    expect(sections[0].key).toBe('pinned');
    expect(sections[0].data).toEqual([note1]);
  });

  it('omits the pinned section when includePinned is false', () => {
    const sections = buildNoteSections([note1], [note2], [], false, t);
    expect(sections.find(s => s.key === 'pinned')).toBeUndefined();
  });

  it('uses key "notes" for unpinned when includePinned is false', () => {
    const sections = buildNoteSections([], [note1], [], false, t);
    expect(sections[0].key).toBe('notes');
    expect(sections[0].title).toBeNull();
  });

  it('uses key "other" for unpinned when includePinned is true but pinned is empty', () => {
    const sections = buildNoteSections([], [note1], [], true, t);
    expect(sections[0].key).toBe('other');
  });

  it('sets null title for unpinned section when there are no pinned notes', () => {
    const sections = buildNoteSections([], [note1], [], true, t);
    expect(sections[0].title).toBeNull();
  });

  it('sets otherNotes title for unpinned section when pinned notes exist', () => {
    const sections = buildNoteSections([note1], [note2], [], true, t);
    const other = sections.find(s => s.key === 'other');
    expect(other?.title).toBe('dashboard.otherNotes');
  });

  it('appends an archived section when displayedArchived is non-empty', () => {
    const sections = buildNoteSections([], [note1], [note3], false, t);
    const archived = sections.find(s => s.key === 'archived');
    expect(archived).toBeDefined();
    expect(archived?.data).toEqual([note3]);
    expect(archived?.title).toBe('dashboard.archivedResults');
  });

  it('omits archived section when displayedArchived is empty', () => {
    const sections = buildNoteSections([], [note1], [], false, t);
    expect(sections.find(s => s.key === 'archived')).toBeUndefined();
  });
});
