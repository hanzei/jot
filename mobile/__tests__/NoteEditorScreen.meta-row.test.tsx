import { Alert, Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigate,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockLabelPicker,
  mockUseUsers,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// Avoid pulling in UserAvatar's network/profile-icon hooks; render a stub.
jest.mock('../src/components/UserAvatar', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ username }: { username: string }) => <Text>{username}</Text>,
  };
});

const sharedNote = {
  id: 'note-1',
  user_id: 'u1',
  note_type: 'text' as const,
  content: 'hello',
  color: '#ffffff',
  pinned: false,
  archived: false,
  is_shared: true,
  shared_with: [{ id: 'share-1', shared_with_user_id: 'u2', username: 'bob' }],
  labels: [{ id: 'lbl-1', name: 'Geschenkideen' }],
};

describe('NoteEditorScreen collaborators + labels row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: sharedNote });
    mockUseUsers.mockReturnValue({
      usersById: new Map([
        ['u1', { id: 'u1', username: 'alice' }],
        ['u2', { id: 'u2', username: 'bob' }],
      ]),
    });
    // Render a detectable node when the label picker is open, so a test can
    // assert that tapping a label chip / "Add labels" surfaced it.
    mockLabelPicker.mockImplementation(({ visible }: { visible: boolean }) =>
      visible ? <Text testID="label-picker-open">picker</Text> : null);
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the note labels and collaborators', async () => {
    const { getByText, getByTestId, queryByText } = render(<NoteEditorScreen />);
    await waitFor(() => {
      expect(getByTestId('note-meta-label-lbl-1')).toBeTruthy();
    });
    expect(getByText('Geschenkideen')).toBeTruthy();
    // Collaborator avatars exclude the current user (alice, u1), matching the
    // dashboard cards; the shared collaborator (bob) is shown.
    expect(getByTestId('note-meta-collaborators')).toBeTruthy();
    expect(getByText('bob')).toBeTruthy();
    expect(queryByText('alice')).toBeNull();
  });

  it('opens the label picker when a label chip is tapped', async () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-label-lbl-1')).toBeTruthy());
    expect(queryByTestId('label-picker-open')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('note-meta-label-lbl-1'));
    });

    await waitFor(() => expect(getByTestId('label-picker-open')).toBeTruthy());
    // On a saved note the open is instant — well under the pending bar's show
    // delay — so the loading bar never flashes in and shoves the note down.
    expect(queryByTestId('menu-action-pending')).toBeNull();
  });

  it('does not render an "Add labels" affordance in the meta row', async () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-row')).toBeTruthy());
    expect(queryByTestId('note-meta-add-labels')).toBeNull();
  });

  it('navigates to the share screen when a collaborator avatar is tapped', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-collaborators')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('note-meta-collaborators'));
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('Share', { noteId: 'note-1' });
    });
  });

  it('renders collaborators non-interactively on a read-only (trashed) note', async () => {
    // Opened from the trash: read-only, so the avatars mirror the menu having
    // no Share action here — they display but do not navigate.
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1', readOnly: true } });
    const { getByTestId, getByText, queryByText } = render(<NoteEditorScreen />);
    await waitFor(() => expect(getByTestId('note-meta-collaborators')).toBeTruthy());
    expect(getByText('bob')).toBeTruthy();
    expect(queryByText('alice')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('note-meta-collaborators'));
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
