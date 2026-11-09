import { render, waitFor } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { useTopBanners } from '../src/hooks/useTopBanners';
import { makeTextNote } from './helpers/fixtures';

jest.mock('../src/store/OfflineContext', () => ({
  ...jest.requireActual('../src/store/OfflineContext'),
  useFailedNoteIds: () => new Set(['note-1']),
}));
jest.mock('../src/hooks/useTopBanners', () => ({
  useTopBanners: jest.fn(),
}));

const mockUseTopBanners = useTopBanners as jest.Mock;

const note = makeTextNote({ id: 'note-1', content: 'hello' });

// The global "N changes couldn't be saved — Review" banner says the same thing
// as the note's own failed-change bar, so the bar only takes over once the
// global banner is gone.
describe('NoteEditorScreen failed-change bar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: note });
  });

  it('is hidden while the global failed-changes banner is showing', async () => {
    mockUseTopBanners.mockReturnValue({ status: null, shown: ['syncFailures'] });
    const { getByText, queryByTestId } = await render(<NoteEditorScreen />);
    await waitFor(() => expect(getByText('hello')).toBeTruthy());
    expect(queryByTestId('editor-failed-bar')).toBeNull();
  });

  it('shows once the global banner is gone', async () => {
    mockUseTopBanners.mockReturnValue({ status: null, shown: [] });
    const { getByTestId } = await render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('editor-failed-bar')).toBeTruthy());
  });
});
