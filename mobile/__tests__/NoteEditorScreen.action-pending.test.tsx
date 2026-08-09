import { Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockGoBack,
  mockReplace,
  mockNavigate,
  mockNavigationAddListener,
  mockCreateMutateAsync,
  mockUpdateMutateAsync,
  mockDeleteMutateAsync,
  mockConvertMutateAsync,
  mockUseOfflineNote,
  mockLabelPicker,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';

// Issue #697: overflow-menu actions (move to trash, convert, share, manage
// labels, redirect-share) await a write with the menu sheet already closed and
// no spinner. These tests assert the fix: a visible pending indicator while the
// server is reachable (the write might genuinely stall for the write timeout),
// and no indicator — because there's nothing to wait for — when the server is
// already known unreachable.

const mockListServers = jest.fn();
const mockGetActiveServer = jest.fn();

jest.mock('../src/store/serverAccounts', () => ({
  __esModule: true,
  listServers: () => mockListServers(),
  getActiveServer: () => mockGetActiveServer(),
}));

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    user_id: 'u1',
    note_type: 'text',
    title: '',
    content: 'Existing content',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    shared_with: [],
    is_shared: false,
    ...overrides,
  };
}

/** A promise the test can resolve on demand, to observe the pending window. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('NoteEditorScreen menu-action pending indicator (#697)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: makeNote() });
    mockCreateMutateAsync.mockResolvedValue({ id: 'note-1' });
    mockUpdateMutateAsync.mockResolvedValue({});
    mockDeleteMutateAsync.mockResolvedValue({});
    mockConvertMutateAsync.mockResolvedValue({});
    // Render a detectable marker only while the picker is visible so tests can
    // assert the save-first flow actually opened it.
    mockLabelPicker.mockImplementation(({ visible }: { visible: boolean }) =>
      visible ? <Text testID="label-picker-open" /> : null);
    markServerReachable();
  });

  afterEach(() => {
    jest.useRealTimers();
    markServerReachable();
  });

  describe('move to trash', () => {
    it('shows the pending indicator once the delay elapses while the delete is in flight', async () => {
      jest.useFakeTimers();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<void>();
      mockDeleteMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-trash')); });

      // Not shown until the delay threshold is crossed.
      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();
      expect(getByTestId('toolbar-menu-btn').props.accessibilityState.disabled).toBe(true);

      await act(async () => { resolve(); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockGoBack).toHaveBeenCalled();
    });

    it('does not show the pending indicator when the server is already known unreachable', async () => {
      markServerUnreachable();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<void>();
      mockDeleteMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-trash'));

      // The mutation hasn't resolved yet, but since the server is known-down
      // there is nothing worth showing progress for.
      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolve(); });
      await waitFor(() => { expect(mockGoBack).toHaveBeenCalled(); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
    });
  });

  describe('convert note type', () => {
    it('shows the pending indicator once the delay elapses while converting', async () => {
      jest.useFakeTimers();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<void>();
      mockConvertMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-convert')); });

      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();

      await act(async () => { resolve(); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockReplace).toHaveBeenCalledWith('NoteEditor', { noteId: 'note-1' });
    });

    it('does not show the pending indicator when known unreachable', async () => {
      markServerUnreachable();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<void>();
      mockConvertMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-convert'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolve(); });
      await waitFor(() => { expect(mockReplace).toHaveBeenCalled(); });
    });
  });

  describe('share (withSavedNote)', () => {
    it('shows the pending indicator once the delay elapses while a pending edit is flushed before navigating to Share', async () => {
      jest.useFakeTimers();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<Record<string, unknown>>();
      mockUpdateMutateAsync.mockReturnValue(promise);

      // An existing note opens read-only-preview first; enter edit mode, then
      // dirty it so withSavedNote's flush actually hits the network.
      fireEvent.press(getByTestId('content-preview'));
      fireEvent.changeText(getByTestId('note-content-input'), 'Existing content, edited');

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-share')); });

      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();

      await act(async () => { resolve({}); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockNavigate).toHaveBeenCalledWith('Share', { noteId: 'note-1' });
    });

    it('does not show the pending indicator when known unreachable', async () => {
      markServerUnreachable();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<Record<string, unknown>>();
      mockUpdateMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('content-preview'));
      fireEvent.changeText(getByTestId('note-content-input'), 'Existing content, edited');

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-share'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolve({}); });
      await waitFor(() => { expect(mockNavigate).toHaveBeenCalledWith('Share', { noteId: 'note-1' }); });
    });
  });

  describe('manage labels (withSavedNote)', () => {
    it('shows the pending indicator once the delay elapses while a pending edit is flushed before opening the label picker', async () => {
      jest.useFakeTimers();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<Record<string, unknown>>();
      mockUpdateMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('content-preview'));
      fireEvent.changeText(getByTestId('note-content-input'), 'Existing content, edited');

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      await act(async () => { fireEvent.press(getByTestId('editor-menu-label')); });

      // Not shown immediately — only after the delay, and not until then.
      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();
      expect(queryByTestId('label-picker-open')).toBeNull();

      await act(async () => { resolve({}); });
      // Held for the min-visible window, then hidden; the picker is now open.
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(getByTestId('label-picker-open')).toBeTruthy();
    });

    it('does not show the pending indicator when known unreachable', async () => {
      markServerUnreachable();
      const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
      const { promise, resolve } = deferred<Record<string, unknown>>();
      mockUpdateMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('content-preview'));
      fireEvent.changeText(getByTestId('note-content-input'), 'Existing content, edited');

      fireEvent.press(getByTestId('toolbar-menu-btn'));
      fireEvent.press(getByTestId('editor-menu-label'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolve({}); });
      await waitFor(() => { expect(getByTestId('label-picker-open')).toBeTruthy(); });
    });
  });

  describe('redirect share to another server', () => {
    beforeEach(() => {
      mockUseRoute.mockReturnValue({ params: { noteId: null, sharedText: 'Shared text' } });
      mockUseOfflineNote.mockReturnValue({ data: undefined });
      mockListServers.mockResolvedValue([
        { serverId: 'server-a', serverUrl: 'https://a.example', displayName: 'Server A' },
        { serverId: 'server-b', serverUrl: 'https://b.example', displayName: 'Server B' },
      ]);
      mockGetActiveServer.mockResolvedValue({ serverId: 'server-a', serverUrl: 'https://a.example' });
    });

    it('shows the pending indicator while reachable and deleting the draft created on the current server', async () => {
      jest.useFakeTimers();
      const { getByTestId, findByTestId, queryByTestId } = render(<NoteEditorScreen />);

      // Let the auto-save fire so a draft note exists on the current server.
      await act(async () => { jest.advanceTimersByTime(1500); });
      await waitFor(() => { expect(mockCreateMutateAsync).toHaveBeenCalled(); });

      await findByTestId('share-change-server-btn');
      fireEvent.press(getByTestId('share-change-server-btn'));

      const { promise, resolve } = deferred<void>();
      mockDeleteMutateAsync.mockReturnValue(promise);

      await act(async () => { fireEvent.press(getByTestId('share-server-option-server-b')); });

      expect(queryByTestId('menu-action-pending')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(600); });
      expect(getByTestId('menu-action-pending')).toBeTruthy();

      await act(async () => { resolve(); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(queryByTestId('menu-action-pending')).toBeNull();
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith('note-1');
    });

    it('does not show the pending indicator when known unreachable', async () => {
      jest.useFakeTimers();
      markServerUnreachable();
      const { getByTestId, findByTestId, queryByTestId } = render(<NoteEditorScreen />);

      await act(async () => { jest.advanceTimersByTime(1500); });

      await findByTestId('share-change-server-btn');
      fireEvent.press(getByTestId('share-change-server-btn'));

      const { promise, resolve } = deferred<void>();
      mockDeleteMutateAsync.mockReturnValue(promise);

      fireEvent.press(getByTestId('share-server-option-server-b'));

      expect(queryByTestId('menu-action-pending')).toBeNull();

      await act(async () => { resolve(); });
    });
  });
});
