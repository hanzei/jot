import { describe, it, expect } from 'vitest';
import { isNoteSharedWithUser, noteNoticeTitle, noteShareNoticeParts } from '../noteShareNotice';
import type { Note, NoteItem, NoteSSEEvent, User } from '../types';

const base = {
  id: 'n1',
  user_id: 'owner',
  version: 1,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  is_shared: true,
  unread: 'new' as const,
  labels: [],
  deleted_at: null,
  created_at: '',
  updated_at: '',
};

const textNote = (content: string): Note => ({ ...base, note_type: 'text', content });
const listNote = (title: string, itemTexts: string[] = []): Note => ({
  ...base,
  note_type: 'list',
  title,
  checked_items_collapsed: false,
  items: itemTexts.map((text, position): NoteItem => ({
    id: `i${position}`,
    note_id: 'n1',
    text,
    completed: false,
    position,
    parent_id: null,
    assigned_to: '',
    created_at: '',
    updated_at: '',
  })),
});

function shareEvent(overrides: Partial<NoteSSEEvent> = {}): NoteSSEEvent {
  return {
    type: 'note_shared',
    source_user_id: 'owner',
    target_user_id: 'me',
    data: { note_id: 'n1', note: textNote('hi') },
    ...overrides,
  };
}

describe('isNoteSharedWithUser', () => {
  it('matches a share that targets the current user', () => {
    expect(isNoteSharedWithUser(shareEvent(), 'me')).toBe(true);
  });

  it('ignores a share that targets someone else in the audience', () => {
    expect(isNoteSharedWithUser(shareEvent({ target_user_id: 'other' }), 'me')).toBe(false);
  });

  it('ignores a share without a target (older server)', () => {
    const event = shareEvent();
    delete event.target_user_id;
    expect(isNoteSharedWithUser(event, 'me')).toBe(false);
  });

  it('ignores the sharer and a missing current user', () => {
    expect(isNoteSharedWithUser(shareEvent({ source_user_id: 'me' }), 'me')).toBe(false);
    expect(isNoteSharedWithUser(shareEvent(), undefined)).toBe(false);
  });

  it('ignores other note events', () => {
    expect(isNoteSharedWithUser(shareEvent({ type: 'note_updated' }), 'me')).toBe(false);
  });
});

describe('noteNoticeTitle', () => {
  it("uses a list note's title", () => {
    expect(noteNoticeTitle(listNote('  Groceries  '))).toBe('Groceries');
  });

  it("uses a text note's first non-empty line without a heading marker", () => {
    expect(noteNoticeTitle(textNote('\n\n## Trip plan\nday one'))).toBe('Trip plan');
  });

  it("falls back to an untitled list's first non-empty item", () => {
    expect(noteNoticeTitle(listNote('', ['  ', 'Buy milk']))).toBe('Buy milk');
  });

  it('is empty when there is nothing to show', () => {
    expect(noteNoticeTitle(textNote('  \n '))).toBe('');
    expect(noteNoticeTitle(listNote(''))).toBe('');
  });

  it('truncates long titles with an ellipsis', () => {
    expect(noteNoticeTitle(listNote('abcdefghij'), 6)).toBe('abcde…');
    expect(noteNoticeTitle(listNote('abcdef'), 6)).toBe('abcdef');
  });
});

describe('noteShareNoticeParts', () => {
  const alice: User = {
    id: 'owner',
    username: 'alice',
    first_name: 'Alice',
    last_name: 'Smith',
    role: 'user',
    has_profile_icon: false,
    created_at: '',
    updated_at: '',
  };

  it('names the sharer and the note', () => {
    expect(noteShareNoticeParts(shareEvent({ data: { note_id: 'n1', note: listNote('Trip') } }), new Map([[alice.id, alice]])))
      .toEqual({ name: 'Alice Smith', title: 'Trip' });
  });

  it('leaves unknown parts empty for the caller to fill in', () => {
    expect(noteShareNoticeParts(shareEvent({ data: { note_id: 'n1', note: null } }), new Map()))
      .toEqual({ name: '', title: '' });
  });
});
