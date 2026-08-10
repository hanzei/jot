import { Alert } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockCreateMutateAsync,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

describe('NoteEditorScreen new-list quick action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'server-1', note_type: 'list', title: '' });
    mockUpdateMutateAsync.mockResolvedValue({});
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens a brand-new note directly in list mode when initialNoteType is "list"', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null, initialNoteType: 'list' } });
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    // List UI is shown (title input + add-item row), not the text content input.
    expect(getByTestId('note-title-input')).toBeTruthy();
    expect(getByTestId('add-list-item')).toBeTruthy();
    expect(queryByTestId('note-content-input')).toBeNull();
  });

  it('opens a brand-new note in text mode by default', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('note-content-input')).toBeTruthy();
    expect(queryByTestId('add-list-item')).toBeNull();
  });

  it('measures the title limit in code points, not UTF-16 units', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null, initialNoteType: 'list' } });
    const { getByTestId } = render(<NoteEditorScreen />);

    // 150 emoji is 300 UTF-16 units but only 150 code points, which is what the
    // server counts against TITLE_MAX_LENGTH — so it must be accepted whole.
    const title = '\u{1F600}'.repeat(150);
    const titleInput = getByTestId('note-title-input');
    fireEvent.changeText(titleInput, title);

    expect(titleInput.props.value).toBe(title);
  });

  it('clamps an over-limit title without splitting a surrogate pair', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null, initialNoteType: 'list' } });
    const { getByTestId } = render(<NoteEditorScreen />);

    // The leading 'a' puts the 200th UTF-16 unit inside an emoji, so a .slice
    // would leave a lone surrogate that the server stores as U+FFFD.
    const titleInput = getByTestId('note-title-input');
    fireEvent.changeText(titleInput, `a${'\u{1F600}'.repeat(300)}`);

    const value: string = titleInput.props.value;
    expect([...value]).toHaveLength(VALIDATION.TITLE_MAX_LENGTH);
    expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
