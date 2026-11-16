import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockDispatch,
  mockNavigationAddListener,
  mockCreateMutateAsync,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
  mockShowToast,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { allowConsoleError } from './helpers/consoleGuard';

type BeforeRemoveEvent = { preventDefault: jest.Mock; data: { action: object } };

function getBeforeRemoveHandler() {
  const calls = mockNavigationAddListener.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.[0] === 'beforeRemove') {
      return calls[i]?.[1] as (event: BeforeRemoveEvent) => void;
    }
  }
  return undefined;
}

function makeEvent(): BeforeRemoveEvent {
  return { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
}

describe('NoteEditorScreen exit save behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'created-note-id' });
    mockUpdateMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // A save commits locally and queues for the drain (#1284): leaving never waits
  // on it, and a server rejection shows up later as a failed change.
  it('navigates without waiting for the save to finish', async () => {
    // The save never settles: the exit must not depend on it.
    mockCreateMutateAsync.mockImplementation(() => new Promise(() => {}));

    const { getByTestId, queryByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    await act(() => { beforeRemove(event); });

    // Navigation proceeds (no preventDefault) and no Retry/Discard dialog is
    // shown; the edit is flushed in the background.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
    await waitFor(() => { expect(mockCreateMutateAsync).toHaveBeenCalled(); });
  });

  it('does not drop edits typed while a save is in flight', async () => {
    jest.useFakeTimers();
    // First create stays in flight until we resolve it manually.
    let resolveCreate!: (value: { id: string }) => void;
    mockCreateMutateAsync.mockImplementation(
      () => new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; }),
    );

    const { getByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    // Fire the debounced autosave; the create request is now in flight.
    await act(() => { jest.advanceTimersByTime(1500); });
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

    // Type more while the save is still in flight.
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello world');

    // Let the in-flight create finish. This must NOT mark the mid-save edit clean.
    await act(async () => { resolveCreate({ id: 'created-note-id' }); });

    // Exiting must flush the mid-save edit instead of leaving without saving.
    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    await act(() => { beforeRemove(event); });

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'created-note-id',
          data: expect.objectContaining({ content: 'Hello world' }),
        }),
      );
    });
  });

  it('updates the draft it is creating when the editor closes mid-create, instead of creating a second note', async () => {
    jest.useFakeTimers();
    let resolveCreate!: (value: { id: string; version: number }) => void;
    mockCreateMutateAsync.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    const { getByTestId, unmount } = await render(<NoteEditorScreen />);
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');
    // The autosave starts the create.
    await act(() => { jest.advanceTimersByTime(1500); });
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

    // More typing, then leave: the exit's flush queues behind the create.
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello world');
    const beforeRemove = getBeforeRemoveHandler()!;
    await act(() => { beforeRemove(makeEvent()); });
    await unmount();

    await act(async () => { resolveCreate({ id: 'created-note-id', version: 1 }); });

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'created-note-id', data: expect.objectContaining({ content: 'Hello world' }) }),
      );
    });
    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('swallows a second back press while a dirty editor zooms back onto its card', async () => {
    mockUseRoute.mockReturnValue({ params: { noteId: null, originRect: { x: 0, y: 0, width: 100, height: 100 } } });
    mockCreateMutateAsync.mockResolvedValue({ id: 'new-note-id', version: 1 });

    const { getByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const first = makeEvent();
    await act(() => { beforeRemove(first); });
    expect(first.preventDefault).toHaveBeenCalled();

    // Pressed again before the zoom-close animation dispatches: it must not pop
    // the screen on its own, or the animation's dispatch would pop a second one.
    const second = makeEvent();
    await act(() => { beforeRemove(second); });
    expect(second.preventDefault).toHaveBeenCalled();
  });

  it('does not block navigation when there are no pending changes', async () => {
    const { queryByTestId } = await render(<NoteEditorScreen />);

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    beforeRemove(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('surfaces a save-error toast when the background flush fails', async () => {
    allowConsoleError('Failed to save note:');
    // The in-editor banner is suppressed by the unmounting guard, so a save
    // that fails locally must surface via a global toast instead.
    mockCreateMutateAsync.mockRejectedValue(new Error('local persist failed'));

    const { getByTestId } = await render(<NoteEditorScreen />);
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');

    const beforeRemove = getBeforeRemoveHandler()!;
    const event = makeEvent();
    await act(() => { beforeRemove(event); });

    expect(event.preventDefault).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('note.failedSaveChanges', 'error');
    });
  });
});
