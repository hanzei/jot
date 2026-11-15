import { render, fireEvent, act } from '@testing-library/react-native';
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
});
