import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { VALIDATION } from '@jot/shared';
import NoteCard from '../src/components/NoteCard';
import i18n from '../src/i18n';
import type { Note } from '@jot/shared';

jest.mock('../src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({
    user: { id: 'current-user', username: 'testuser' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

jest.mock('../src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => ({
    usersById: new Map(),
    refreshUsers: jest.fn(),
  }),
}));

let mockFailedNoteIds = new Set<string>();
jest.mock('../src/store/OfflineContext', () => ({
  __esModule: true,
  useFailedNoteIds: () => mockFailedNoteIds,
}));

jest.mock('../src/hooks/useActiveServerBaseUrl', () => ({
  useActiveServerBaseUrl: () => 'http://test-server',
}));

const baseNote: Note = {
  id: 'note-1',
  user_id: 'user-1',
  content: 'Some content here',
  note_type: 'text',
  version: 1,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  shared_with: [],
  is_shared: false,
  labels: [],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const baseListNote: Note = {
  id: 'note-1',
  user_id: 'user-1',
  title: 'Test List Note',
  note_type: 'list',
  version: 1,
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  checked_items_collapsed: false,
  shared_with: [],
  is_shared: false,
  labels: [],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

/**
 * Every string a rendered node contains, i.e. what the card actually shows.
 *
 * Walks *rendered* children rather than `props.children`, so it can see through
 * a component that builds its own output — InlineMarkdown passes nothing down,
 * it renders from the item text.
 */
const read = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(read).join('');
  const rendered = (node as { children?: unknown[] })?.children;
  if (Array.isArray(rendered)) return rendered.map(read).join('');
  const children = (node as { props?: { children?: unknown } })?.props?.children;
  return children === undefined ? '' : read(children);
};

describe('NoteCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    mockFailedNoteIds = new Set<string>();
  });

  it('shows a "didn\'t sync" badge for a note in the failed sync state', () => {
    mockFailedNoteIds = new Set(['note-1']);
    const { getByTestId, getByText } = render(<NoteCard note={baseNote} onPress={jest.fn()} />);

    expect(getByTestId('note-failed-badge-note-1')).toBeTruthy();
    expect(getByText("Didn't sync")).toBeTruthy();
  });

  it('does not show the badge for a normally-synced note', () => {
    const { queryByTestId } = render(<NoteCard note={baseNote} onPress={jest.fn()} />);

    expect(queryByTestId('note-failed-badge-note-1')).toBeNull();
  });

  it('renders content for text notes', () => {
    const { getByText } = render(<NoteCard note={baseNote} onPress={jest.fn()} />);

    expect(getByText('Some content here')).toBeTruthy();
  });

  it('renders text-note content as Markdown, clamped', () => {
    const note = { ...baseNote, content: '# Groceries\n\n- **milk**\n- eggs' };
    const { getByTestId } = render(<NoteCard note={note} onPress={jest.fn()} />);

    const preview = getByTestId('note-card-content-note-1');
    // The clamp is what keeps a long note from blowing out the card; the card
    // itself sets no height, so this prop is the whole mechanism.
    expect(preview.props.numberOfLines).toBe(6);

    expect(read(preview)).toBe('Groceries\n• milk\n• eggs');
  });

  // The card is one control that opens the note, so nothing inside it may take
  // the tap. Asserted on both card surfaces, since each has its own renderer.
  //
  // The fixture carries an autolinked URL *and* a `[label](url)` link, and the
  // visible text is asserted alongside the absence of a handler: on its own,
  // "nothing is tappable" would also pass if link parsing had broken entirely,
  // which would show `[docs](…)` as literal source rather than `docs`.
  it('renders links in a card as plain text, on both note types', () => {
    const linkText = 'see https://example.com and [docs](https://example.org)';
    const asPlainText = 'see https://example.com and docs';

    const tappable = (node: unknown): number => {
      if (typeof node !== 'object' || node === null) return 0;
      const props = (node as { props?: { children?: unknown; onPress?: unknown } }).props;
      const own = typeof props?.onPress === 'function' ? 1 : 0;
      const children = props?.children;
      const kids = Array.isArray(children) ? children : [children];
      return own + kids.reduce<number>((sum, kid) => sum + tappable(kid), 0);
    };

    const textNote = { ...baseNote, content: linkText };
    const { getByTestId } = render(<NoteCard note={textNote} onPress={jest.fn()} />);
    const preview = getByTestId('note-card-content-note-1');
    expect(read(preview)).toBe(asPlainText);
    expect(tappable(preview)).toBe(0);

    const listNote: Note = {
      ...baseListNote,
      items: [
        {
          id: 'item-1',
          note_id: 'note-1',
          text: linkText,
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };
    const list = render(<NoteCard note={listNote} onPress={jest.fn()} />);
    const row = list.getByTestId('note-card-list-row-item-1');
    expect(read(row)).toContain(asPlainText);
    expect(tappable(row)).toBe(0);
  });

  it('renders title for list notes', () => {
    const { getByText } = render(<NoteCard note={baseListNote} onPress={jest.fn()} />);

    expect(getByText('Test List Note')).toBeTruthy();
  });

  it('renders list item previews for list notes', () => {
    const listNote: Note = {
      ...baseListNote,
      items: [
        {
          id: 'item-1',
          note_id: 'note-1',
          text: 'Buy groceries',
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'item-2',
          note_id: 'note-1',
          text: 'Done task',
          completed: true,
          position: 1,
          parent_id: null,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(<NoteCard note={listNote} onPress={jest.fn()} />);

    expect(getByText('Buy groceries')).toBeTruthy();
    expect(getByText('+1 completed items')).toBeTruthy();
  });

  it('indents list preview rows using parent_id', () => {
    const listWithNestedItems: Note = {
      ...baseListNote,
      items: [
        {
          id: 'item-parent',
          note_id: 'note-1',
          text: 'Parent task',
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'item-child',
          note_id: 'note-1',
          text: 'Child task',
          completed: false,
          position: 1,
          parent_id: 'item-parent',
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByTestId } = render(<NoteCard note={listWithNestedItems} onPress={jest.fn()} />);

    const parentRow = getByTestId('note-card-list-row-item-parent');
    const childRow = getByTestId('note-card-list-row-item-child');

    expect(StyleSheet.flatten(parentRow.props.style)?.marginLeft).toBe(0);
    expect(StyleSheet.flatten(childRow.props.style)?.marginLeft).toBe(1 * VALIDATION.INDENT_PX_PER_LEVEL);
  });

  it('renders top-level list item with zero indentation', () => {
    const listWithTopLevelItem: Note = {
      ...baseListNote,
      items: [
        {
          id: 'item-top-level',
          note_id: 'note-1',
          text: 'Top-level task',
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByTestId } = render(<NoteCard note={listWithTopLevelItem} onPress={jest.fn()} />);
    const row = getByTestId('note-card-list-row-item-top-level');

    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(0);
  });

  it('allows list preview text to wrap instead of truncating', () => {
    const longListNote: Note = {
      ...baseListNote,
      items: [
        {
          id: 'item-wrap',
          note_id: 'note-1',
          text: 'This is a very long list item that should wrap to multiple lines in note previews on mobile',
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(<NoteCard note={longListNote} onPress={jest.fn()} />);
    const listText = getByText(longListNote.items?.[0]?.text ?? '');

    expect(listText.props.numberOfLines).toBeUndefined();
  });

  it('renders label chips', () => {
    const noteWithLabels: Note = {
      ...baseNote,
      labels: [
        { id: 'l1', user_id: 'user-1', name: 'Work', created_at: '', updated_at: '' },
        { id: 'l2', user_id: 'user-1', name: 'Personal', created_at: '', updated_at: '' },
      ],
    };

    const { getByText } = render(<NoteCard note={noteWithLabels} onPress={jest.fn()} />);

    expect(getByText('Work')).toBeTruthy();
    expect(getByText('Personal')).toBeTruthy();
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(<NoteCard note={baseNote} onPress={onPress} />);

    fireEvent.press(getByTestId('note-card-note-1'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('uses note color as background for colored notes', () => {
    const coloredNote: Note = { ...baseNote, color: '#fbbc04' };
    const { getByTestId } = render(<NoteCard note={coloredNote} onPress={jest.fn()} />);

    const card = getByTestId('note-card-note-1');
    expect(StyleSheet.flatten(card.props.style)?.backgroundColor).toBe('#fbbc04');
  });

  it('uses default white background for notes without color', () => {
    const { getByTestId } = render(<NoteCard note={baseNote} onPress={jest.fn()} />);

    const card = getByTestId('note-card-note-1');
    expect(StyleSheet.flatten(card.props.style)?.backgroundColor).toBe('#fff');
  });

  it('treats shorthand white note color as default background', () => {
    const shorthandWhiteNote: Note = { ...baseNote, color: '#fff' };
    const { getByTestId } = render(<NoteCard note={shorthandWhiteNote} onPress={jest.fn()} />);

    const card = getByTestId('note-card-note-1');
    expect(StyleSheet.flatten(card.props.style)?.backgroundColor).toBe('#fff');
  });

  it('does not render title when empty for list notes', () => {
    const noTitleNote: Note = { ...baseListNote, title: '' };
    const { queryByText } = render(<NoteCard note={noTitleNote} onPress={jest.fn()} />);

    expect(queryByText('Test List Note')).toBeNull();
  });

  it('does not show assignee avatar for assigned list items', () => {
    const sharedList: Note = {
      ...baseListNote,
      is_shared: true,
      items: [
        {
          id: 'item-1',
          note_id: 'note-1',
          text: 'Assigned task',
          completed: false,
          position: 0,
          parent_id: null,
          assigned_to: 'user-2',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText, queryByText } = render(
      <NoteCard note={sharedList} onPress={jest.fn()} />,
    );

    expect(getByText('Assigned task')).toBeTruthy();
    // Assignee avatar letter 'B' (for user-2) should not appear in the preview
    expect(queryByText('B')).toBeNull();
  });

  it('renders owner avatar for shared-with-you notes', () => {
    const sharedNote: Note = {
      ...baseNote,
      user_id: 'owner-1',
      is_shared: true,
      shared_with: [
        {
          id: 'share-1',
          note_id: 'note-1',
          shared_with_user_id: 'current-user',
          shared_by_user_id: 'owner-1',
          username: 'testuser',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(
      <NoteCard note={sharedNote} onPress={jest.fn()} />,
    );

    // Owner avatar letter '?' shown (owner not in usersById mock)
    expect(getByText('?')).toBeTruthy();
  });

  it('renders avatars for notes shared by the owner', () => {
    const ownedSharedNote: Note = {
      ...baseNote,
      user_id: 'current-user',
      shared_with: [
        {
          id: 'share-1',
          note_id: 'note-1',
          shared_with_user_id: 'user-2',
          shared_by_user_id: 'current-user',
          username: 'bob',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(
      <NoteCard note={ownedSharedNote} onPress={jest.fn()} />,
    );

    expect(getByText('B')).toBeTruthy();
  });

  it('renders a cover image from the note\'s first image', () => {
    const noteWithImages: Note = {
      ...baseNote,
      images: [
        { id: 'img-1', filename: 'photo.png', content_type: 'image/png', width: 800, height: 600, created_at: '2024-01-01T00:00:00Z' },
      ],
    };

    const { getByTestId } = render(<NoteCard note={noteWithImages} onPress={jest.fn()} />);

    expect(getByTestId('note-card-cover-note-1')).toBeTruthy();
  });

  it('shows a "+N" badge when the note has more than one image', () => {
    const noteWithImages: Note = {
      ...baseNote,
      images: [
        { id: 'img-1', filename: 'a.png', content_type: 'image/png', width: 800, height: 600, created_at: '2024-01-01T00:00:00Z' },
        { id: 'img-2', filename: 'b.png', content_type: 'image/png', width: 800, height: 600, created_at: '2024-01-01T00:00:00Z' },
        { id: 'img-3', filename: 'c.png', content_type: 'image/png', width: 800, height: 600, created_at: '2024-01-01T00:00:00Z' },
      ],
    };

    const { getByText } = render(<NoteCard note={noteWithImages} onPress={jest.fn()} />);

    expect(getByText('+2')).toBeTruthy();
  });

  it('does not render a cover image when the note has no images', () => {
    const { queryByTestId } = render(<NoteCard note={baseNote} onPress={jest.fn()} />);

    expect(queryByTestId('note-card-cover-note-1')).toBeNull();
  });
});
