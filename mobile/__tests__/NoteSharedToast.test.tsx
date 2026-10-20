import { render, act } from '@testing-library/react-native';
import type { SSEEvent, User } from '@jot/shared';
import NoteSharedToast from '../src/components/NoteSharedToast';
import { makeListNote } from './helpers/fixtures';

let listener: ((event: SSEEvent) => void) | undefined;
jest.mock('../src/store/SSEContext', () => ({
  useSSEContext: () => ({
    subscribe: (fn: (event: SSEEvent) => void) => {
      listener = fn;
      return () => { listener = undefined; };
    },
    sseReconnecting: false,
  }),
}));

const mockShowToast = jest.fn();
jest.mock('../src/hooks/useToast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const alice: User = {
  id: 'owner-1',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  has_profile_icon: false,
  created_at: '',
  updated_at: '',
};
let mockUsersById = new Map<string, User>([[alice.id, alice]]);
jest.mock('../src/store/UsersContext', () => ({
  useUsers: () => ({ usersById: mockUsersById, refreshUsers: jest.fn() }),
}));

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

function sharedEvent(title: string): SSEEvent {
  return {
    type: 'note_shared',
    source_user_id: 'owner-1',
    target_user_id: 'current-user',
    data: { note_id: 'shared-1', note: makeListNote({ id: 'shared-1', title }) },
  };
}

describe('NoteSharedToast', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsersById = new Map([[alice.id, alice]]);
  });

  it('names the sharer and the note, and opens the note from the toast', async () => {
    await render(<NoteSharedToast />);

    await act(() => {
      listener?.(sharedEvent('Trip plan'));
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      'Alice Smith shared “Trip plan” with you',
      'info',
      expect.objectContaining({ label: 'Open' }),
    );
    const action = mockShowToast.mock.calls[0]![2];
    await act(async () => {
      await action.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('NoteEditor', { noteId: 'shared-1' });
  });

  it('falls back when the sharer is unknown and the note has no title', async () => {
    mockUsersById = new Map();
    await render(<NoteSharedToast />);

    await act(() => {
      listener?.(sharedEvent(''));
    });

    expect(mockShowToast).toHaveBeenCalledWith('Someone shared “Untitled note” with you', 'info', expect.anything());
  });

  it('ignores other events', async () => {
    await render(<NoteSharedToast />);

    await act(() => {
      listener?.({ type: 'note_updated', source_user_id: 'owner-1', data: { note_id: 'n', note: null } });
    });

    expect(mockShowToast).not.toHaveBeenCalled();
  });
});
