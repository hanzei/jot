import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockUpdateMutateAsync,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

type BeforeRemoveEvent = { preventDefault: jest.Mock; data: { action: object } };

function getBeforeRemoveHandler() {
  const calls = mockNavigationAddListener.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.[0] === 'beforeRemove') return calls[i]?.[1] as (event: BeforeRemoveEvent) => void;
  }
  return undefined;
}

function textNote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'note-1', user_id: 'u1', title: '', content: 'Hello', note_type: 'text',
    color: '#ffffff', pinned: false, archived: false, position: 0,
    checked_items_collapsed: false, is_shared: false, deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    labels: [], shared_with: [], items: [], version: 5,
    ...overrides,
  };
}

describe('NoteEditorScreen save base version (#1277)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUpdateMutateAsync.mockResolvedValue({ version: 7 });
  });

  it('saves against the version the editor hydrated from, not a snapshot that arrived mid-edit', async () => {
    mockUseOfflineNote.mockReturnValue({ data: textNote() });
    const { getByTestId, rerender } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('content-preview'));
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello, my edit');

    // A collaborator's save lands in SQLite (v6) while the editor is dirty.
    mockUseOfflineNote.mockReturnValue({ data: textNote({ content: 'Hello, theirs', version: 6 }) });
    await act(async () => { await rerender(<NoteEditorScreen />); });

    const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
    await act(() => { getBeforeRemoveHandler()!(event); });

    expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
      id: 'note-1',
      data: { content: 'Hello, my edit' },
      baseVersion: 5,
    });
  });
  it('does not adopt the version a pin-only patch returns as its baseline', async () => {
    mockUseOfflineNote.mockReturnValue({ data: textNote() });
    const { getByTestId } = await render(<NoteEditorScreen />);

    // Pin PATCH held in flight: pinned is changed locally, baseline not committed.
    mockUpdateMutateAsync.mockImplementationOnce(() => new Promise(() => {}));
    await act(() => { void fireEvent.press(getByTestId('toolbar-pin-btn')); });

    // Type and revert, so the flush patches only `pinned`; the server answers with
    // a collaborator's newer version whose text the editor never applied.
    await fireEvent.press(getByTestId('content-preview'));
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello!');
    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello');
    mockUpdateMutateAsync.mockResolvedValueOnce({ version: 8 });
    const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
    await act(() => { getBeforeRemoveHandler()!(event); });
    expect(mockUpdateMutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { pinned: true } }),
    );

    await fireEvent.changeText(getByTestId('note-content-input'), 'Hello, my edit');
    // The autosave debounce flushes the follow-up content edit.
    await waitFor(() => expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(3), { timeout: 3000 });

    expect(mockUpdateMutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { content: 'Hello, my edit' }, baseVersion: 5 }),
    );
  });
});
