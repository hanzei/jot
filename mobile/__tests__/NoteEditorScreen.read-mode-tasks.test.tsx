import { render, fireEvent, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// Task checkboxes in the open note's read mode are tappable
// (docs/specs/markdown-rendering.md §2.4). Like links, a tap must not also open
// the editor.

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    note_type: 'text',
    title: '',
    content: '- [ ] first\n- [x] second',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    ...overrides,
  };
}

describe('NoteEditorScreen read-mode task checkboxes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: makeNote() });
  });

  it('renders accessible checkboxes with their state', async () => {
    const { getByLabelText } = await render(<NoteEditorScreen />);

    expect(getByLabelText('first').props.accessibilityState).toEqual({ checked: false });
    expect(getByLabelText('second').props.accessibilityState).toEqual({ checked: true });
  });

  it('toggles only the tapped marker, without entering edit mode', async () => {
    const { getByLabelText, queryByTestId, getByTestId, findByLabelText } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.press(getByLabelText('first'));
    });

    expect((await findByLabelText('first')).props.accessibilityState).toEqual({ checked: true });
    expect(getByLabelText('second').props.accessibilityState).toEqual({ checked: true });
    expect(queryByTestId('note-content-input')).toBeNull();
    expect(getByTestId('content-preview')).toBeTruthy();

    // Toggling back restores the original content.
    await act(async () => {
      await fireEvent.press(getByLabelText('second'));
    });
    expect(getByLabelText('second').props.accessibilityState).toEqual({ checked: false });
  });

  it('keeps the toggled content when the editor is opened', async () => {
    const { getByLabelText, getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.press(getByLabelText('first'));
    });
    await act(async () => {
      await fireEvent.press(getByTestId('content-preview'));
    });

    expect(getByTestId('note-content-input').props.value).toBe('- [x] first\n- [x] second');
  });

  it('leaves checkboxes as plain text in a trashed note', async () => {
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ deleted_at: '2026-01-01T00:00:00Z' }) });
    const { queryByLabelText, getByText } = await render(<NoteEditorScreen />);

    expect(queryByLabelText('first')).toBeNull();
    expect(getByText(/☐ first/)).toBeTruthy();
  });
});
