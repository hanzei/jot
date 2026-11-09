import { render, waitFor } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { useOfflineContext } from '../src/store/OfflineContext';

jest.mock('../src/store/OfflineContext', () => {
  const actual = jest.requireActual('../src/store/OfflineContext');
  return {
    ...actual,
    useFailedNoteIds: () => new Set(['note-1']),
    useOfflineContext: jest.fn(),
  };
});

const mockUseOfflineContext = useOfflineContext as jest.Mock;

const note = {
  id: 'note-1',
  user_id: 'u1',
  note_type: 'text' as const,
  content: 'hello',
  color: '#ffffff',
  pinned: false,
  archived: false,
  is_shared: false,
  shared_with: [],
  labels: [],
};

// The global "N changes couldn't be saved — Review" banner says the same thing
// as the note's own failed-change bar, so the bar only takes over once the
// global banner has been dismissed.
describe('NoteEditorScreen failed-change bar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: note });
  });

  it('is hidden while the global failed-changes banner is showing', async () => {
    mockUseOfflineContext.mockReturnValue({ syncFailuresBannerDismissed: false });
    const { getByText, queryByTestId } = await render(<NoteEditorScreen />);
    await waitFor(() => expect(getByText('hello')).toBeTruthy());
    expect(queryByTestId('editor-failed-bar')).toBeNull();
  });

  it('shows once the global banner has been dismissed', async () => {
    mockUseOfflineContext.mockReturnValue({ syncFailuresBannerDismissed: true });
    const { getByTestId } = await render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('editor-failed-bar')).toBeTruthy());
  });
});
