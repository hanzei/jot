/**
 * NoteHistoryScreen (#1129): online-only history of a note with Restore.
 * Revisions come from the (mocked) API and are never stored locally; the note
 * itself and its sync state come from the real test SQLite database, so a
 * restore is checked by reading the note back from it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import type { Note, NoteRevision, NoteRevisionSummary, User } from '@jot/shared';
import NoteHistoryScreen from '../src/screens/NoteHistoryScreen';
import { getNote, getNoteRevision, getNoteRevisions, restoreNoteRevision } from '../src/api/notes';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import { useConfirm } from '../src/hooks/useConfirm';
import { useToast } from '../src/hooks/useToast';
import { useUsers } from '../src/store/UsersContext';
import { useAuth } from '../src/store/AuthContext';
import { useOfflineNote } from '../src/hooks/useOfflineNotes';
import { markServerReachable } from '../src/api/serverReachability';
import { getLocalNote, markNotePendingCreate, saveNote } from '../src/db/noteQueries';
import { enqueueOperation } from '../src/db/syncQueue';
import { makeListNote, makeNoteItem, makeTextNote } from './helpers/fixtures';
import { silenceConsole } from './helpers/consoleGuard';

const mockGoBack = jest.fn();
type BeforeRemoveListener = (e: { preventDefault: () => void }) => void;
const mockBeforeRemove: { current: BeforeRemoveListener | null } = { current: null };
const mockAddListener = jest.fn((_event: string, listener: BeforeRemoveListener) => {
  mockBeforeRemove.current = listener;
  return () => {
    if (mockBeforeRemove.current === listener) mockBeforeRemove.current = null;
  };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, addListener: mockAddListener }),
  useRoute: () => ({ params: { noteId: 'note-1' } }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    __esModule: true,
    SafeAreaInsetsContext: createContext(insets),
  };
});

jest.mock('../src/api/notes', () => ({
  getNote: jest.fn(),
  getNoteRevisions: jest.fn(),
  getNoteRevision: jest.fn(),
  restoreNoteRevision: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: {},
  assertSwitchWriteAllowed: jest.fn(),
  getActiveServerId: () => 'server-1',
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({ useNetworkStatus: jest.fn() }));
jest.mock('../src/hooks/useConfirm', () => ({ useConfirm: jest.fn() }));
jest.mock('../src/hooks/useToast', () => ({ useToast: jest.fn() }));
jest.mock('../src/store/UsersContext', () => ({ useUsers: jest.fn() }));
jest.mock('../src/store/AuthContext', () => ({ useAuth: jest.fn() }));
// The editor's note read also refreshes from the server; the screen only needs
// the local copy, which these tests hand it directly.
jest.mock('../src/hooks/useOfflineNotes', () => ({ useOfflineNote: jest.fn() }));

const mockGetRevisions = getNoteRevisions as jest.MockedFunction<typeof getNoteRevisions>;
const mockGetRevision = getNoteRevision as jest.MockedFunction<typeof getNoteRevision>;
const mockRestore = restoreNoteRevision as jest.MockedFunction<typeof restoreNoteRevision>;
const mockGetNote = getNote as jest.MockedFunction<typeof getNote>;
const mockUseNetworkStatus = useNetworkStatus as jest.MockedFunction<typeof useNetworkStatus>;
const mockUseConfirm = useConfirm as jest.MockedFunction<typeof useConfirm>;
const mockUseToast = useToast as jest.MockedFunction<typeof useToast>;
const mockUseUsers = useUsers as jest.MockedFunction<typeof useUsers>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseOfflineNote = useOfflineNote as jest.MockedFunction<typeof useOfflineNote>;

const mockConfirm = jest.fn();
const mockShowToast = jest.fn();

const alice: User = {
  id: 'user-alice',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Liddell',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function summary(overrides: Partial<NoteRevisionSummary> & { id: string }): NoteRevisionSummary {
  return {
    note_id: 'note-1',
    note_type: 'text',
    title: '',
    actor_id: null,
    edited_at: '2026-10-20T09:30:00Z',
    created_at: '2026-10-20T15:00:00Z',
    ...overrides,
  };
}

function revision(overrides: Partial<NoteRevision> & { id: string }): NoteRevision {
  return { ...summary(overrides), content: '', items: [], ...overrides };
}

const currentNote = makeTextNote({ id: 'note-1', content: 'current text', version: 3 });

async function seedNote(note: Note = currentNote) {
  await saveNote(globalThis.testDb, note);
  mockUseOfflineNote.mockReturnValue({ data: note } as ReturnType<typeof useOfflineNote>);
}

async function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = await render(
    <QueryClientProvider client={queryClient}>
      <NoteHistoryScreen />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

function conflictError(): AxiosError {
  const response = {
    status: 409,
    statusText: 'Conflict',
    data: { error: { code: 'conflict', message: 'note was modified by another write' } },
    headers: {},
    config: { headers: new AxiosHeaders() },
  } as AxiosResponse;
  return new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST', undefined, undefined, response);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBeforeRemove.current = null;
  mockGetNote.mockResolvedValue(currentNote);
  markServerReachable();
  mockUseNetworkStatus.mockReturnValue({ isConnected: true });
  mockConfirm.mockResolvedValue(true);
  mockUseConfirm.mockReturnValue({ confirm: mockConfirm });
  mockUseToast.mockReturnValue({ showToast: mockShowToast });
  mockUseUsers.mockReturnValue({ usersById: new Map([[alice.id, alice]]) } as ReturnType<typeof useUsers>);
  mockUseAuth.mockReturnValue({ user: { id: 'user-me' } } as ReturnType<typeof useAuth>);
});

describe('NoteHistoryScreen', () => {
  it('shows a pending state while the history loads', async () => {
    await seedNote();
    mockGetRevisions.mockReturnValue(new Promise(() => {}));
    await renderScreen();
    expect(await screen.findByTestId('history-loading')).toBeTruthy();
  });

  it('says so when there are no earlier versions', async () => {
    await seedNote();
    mockGetRevisions.mockResolvedValue([]);
    await renderScreen();
    expect(await screen.findByTestId('history-empty')).toBeTruthy();
    expect(screen.getByText('No earlier versions yet')).toBeTruthy();
  });

  it('lists revisions newest first with their authors', async () => {
    await seedNote();
    mockGetRevisions.mockResolvedValue([
      summary({ id: 'rev-me', actor_id: 'user-me' }),
      summary({ id: 'rev-alice', actor_id: alice.id, note_type: 'list', title: 'Groceries' }),
      summary({ id: 'rev-gone', actor_id: 'user-deleted' }),
      summary({ id: 'rev-anon', actor_id: null }),
    ]);
    await renderScreen();

    await screen.findByTestId('history-list');
    expect(screen.getByTestId('history-revision-rev-me')).toHaveTextContent(/2026, .* · You/);
    expect(screen.getByTestId('history-revision-rev-alice')).toHaveTextContent(/Alice Liddell/);
    expect(screen.getByTestId('history-revision-rev-alice')).toHaveTextContent(/List · Groceries/);
    expect(screen.getByTestId('history-revision-rev-gone')).toHaveTextContent(/Unknown user/);
    expect(screen.getByTestId('history-revision-rev-anon')).not.toHaveTextContent(/·/);
  });

  it('explains instead of loading while offline', async () => {
    await seedNote();
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    await renderScreen();
    expect(await screen.findByTestId('history-offline')).toBeTruthy();
    expect(mockGetRevisions).not.toHaveBeenCalled();
  });

  it('does not ask the server about a note whose create has not synced', async () => {
    await seedNote();
    await markNotePendingCreate(globalThis.testDb, 'note-1');
    await renderScreen();
    expect(await screen.findByTestId('history-not-created')).toBeTruthy();
    expect(mockGetRevisions).not.toHaveBeenCalled();
  });

  it('shows an error with Retry when the history fails to load', async () => {
    await seedNote();
    silenceConsole('warn', /.*/);
    mockGetRevisions.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce([]);
    await renderScreen();
    await screen.findByTestId('history-error');
    await fireEvent.press(screen.getByTestId('history-retry'));
    expect(await screen.findByTestId('history-empty')).toBeTruthy();
  });

  it('previews a revision and restores it into the local note', async () => {
    await seedNote();
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-1' })]);
    mockGetRevision.mockResolvedValue(revision({ id: 'rev-1', content: 'older text' }));
    const restored = makeTextNote({ id: 'note-1', content: 'older text', version: 4 });
    mockRestore.mockResolvedValue(restored);
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('history-revision-rev-1'));
    expect(await screen.findByText('older text')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('history-restore'));

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
      message: "The note's current content is kept in its history, so you can undo this.",
    }));
    expect(mockRestore).toHaveBeenCalledWith('note-1', 'rev-1', { base_version: 3 });
    expect(mockShowToast).toHaveBeenCalledWith('Version restored', 'success');
    expect(mockBeforeRemove.current).toBeNull();
    const local = await getLocalNote(globalThis.testDb, 'note-1');
    expect(local).toMatchObject({ note_type: 'text', content: 'older text', version: 4 });
  });

  it('restores a list revision over a text note, converting it back', async () => {
    await seedNote();
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-list', note_type: 'list', title: 'Groceries' })]);
    mockGetRevision.mockResolvedValue(revision({
      id: 'rev-list',
      note_type: 'list',
      title: 'Groceries',
      items: [
        { id: 'i1', text: 'Milk', completed: false, position: 0, parent_id: null, assigned_to: '' },
        { id: 'i2', text: 'Eggs', completed: true, position: 1, parent_id: null, assigned_to: '' },
      ],
    }));
    mockRestore.mockResolvedValue(makeListNote({
      id: 'note-1',
      title: 'Groceries',
      version: 4,
      items: [
        makeNoteItem({ id: 'i1', note_id: 'note-1', text: 'Milk', position: 0 }),
        makeNoteItem({ id: 'i2', note_id: 'note-1', text: 'Eggs', position: 1, completed: true }),
      ],
    }));
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('history-revision-rev-list'));
    expect(await screen.findByText('Milk')).toBeTruthy();
    expect(screen.getByText('Eggs')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('history-restore'));

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('the note becomes a list again'),
    }));
    const local = await getLocalNote(globalThis.testDb, 'note-1');
    expect(local?.note_type).toBe('list');
    expect(local?.note_type === 'list' ? local.items?.map((i) => i.text) : []).toEqual(['Milk', 'Eggs']);
  });

  it("bases the restore on the server's version when the local copy is behind", async () => {
    await seedNote();
    mockGetNote.mockResolvedValue({ ...currentNote, content: 'edited on another device', version: 7 });
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-1' })]);
    mockGetRevision.mockResolvedValue(revision({ id: 'rev-1', content: 'older text' }));
    mockRestore.mockResolvedValue(makeTextNote({ id: 'note-1', content: 'older text', version: 8 }));
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('history-revision-rev-1'));
    await screen.findByText('older text');
    await fireEvent.press(screen.getByTestId('history-restore'));

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
    expect(mockRestore).toHaveBeenCalledWith('note-1', 'rev-1', { base_version: 7 });
  });

  it('steps back from a preview to the list on a hardware back or swipe', async () => {
    await seedNote();
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-1' })]);
    mockGetRevision.mockResolvedValue(revision({ id: 'rev-1', content: 'older text' }));
    await renderScreen();

    expect(mockBeforeRemove.current).toBeNull();
    await fireEvent.press(await screen.findByTestId('history-revision-rev-1'));
    await screen.findByText('older text');
    const preventDefault = jest.fn();
    await act(async () => {
      mockBeforeRemove.current?.({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(await screen.findByTestId('history-revision-rev-1')).toBeTruthy();
    expect(screen.queryByText('older text')).toBeNull();
    expect(mockBeforeRemove.current).toBeNull();
  });

  it('enables Restore once the queued changes have synced', async () => {
    await seedNote();
    await enqueueOperation(globalThis.testDb, {
      operation: 'update',
      endpoint: '/notes/note-1',
      method: 'PATCH',
      body: { content: 'queued edit' },
    });
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-1' })]);
    mockGetRevision.mockResolvedValue(revision({ id: 'rev-1', content: 'older text' }));
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('history-revision-rev-1'));
    await screen.findByText('older text');
    expect(screen.getByTestId('history-restore')).toBeDisabled();

    await globalThis.testDb.runAsync('DELETE FROM sync_queue');
    await waitFor(() => expect(screen.getByTestId('history-restore')).toBeEnabled(), { timeout: 5000 });
    expect(screen.queryByTestId('history-restore-hint')).toBeNull();
  });

  it('blocks a restore while the note has unsynced local changes', async () => {
    await seedNote();
    await enqueueOperation(globalThis.testDb, {
      operation: 'update',
      endpoint: '/notes/note-1',
      method: 'PATCH',
      body: { content: 'queued edit' },
    });
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-1' })]);
    mockGetRevision.mockResolvedValue(revision({ id: 'rev-1', content: 'older text' }));
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('history-revision-rev-1'));
    expect(await screen.findByText('older text')).toBeTruthy();
    expect(screen.getByTestId('history-restore-hint')).toHaveTextContent(/haven't synced yet/);
    expect(screen.getByTestId('history-restore')).toBeDisabled();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('reports a conflict and refreshes the list when the note moved on', async () => {
    await seedNote();
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-1' })]);
    mockGetRevision.mockResolvedValue(revision({ id: 'rev-1', content: 'older text' }));
    mockRestore.mockRejectedValue(conflictError());
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('history-revision-rev-1'));
    await screen.findByText('older text');
    const loadsBefore = mockGetRevisions.mock.calls.length;
    await act(async () => {
      fireEvent.press(screen.getByTestId('history-restore'));
    });

    expect(await screen.findByTestId('history-restore-error')).toHaveTextContent(/changed since you opened its history/);
    await waitFor(() => expect(mockGetRevisions.mock.calls.length).toBeGreaterThan(loadsBefore));
    expect(mockGoBack).not.toHaveBeenCalled();
    const local = await getLocalNote(globalThis.testDb, 'note-1');
    expect(local).toMatchObject({ content: 'current text', version: 3 });
  });

  it('keeps an open preview but disables Restore when the connection drops', async () => {
    await seedNote();
    mockGetRevisions.mockResolvedValue([summary({ id: 'rev-1' })]);
    mockGetRevision.mockResolvedValue(revision({ id: 'rev-1', content: 'older text' }));
    const { rerender, queryClient } = await renderScreen();

    await fireEvent.press(await screen.findByTestId('history-revision-rev-1'));
    await screen.findByText('older text');
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
    await rerender(
      <QueryClientProvider client={queryClient}>
        <NoteHistoryScreen />
      </QueryClientProvider>,
    );

    expect(screen.getByText('older text')).toBeTruthy();
    expect(screen.getByTestId('history-restore-hint')).toHaveTextContent(/Restoring needs a connection/);
    expect(screen.getByTestId('history-restore')).toBeDisabled();
  });
});
