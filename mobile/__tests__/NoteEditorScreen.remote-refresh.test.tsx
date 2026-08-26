import { render, act, fireEvent, waitFor } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { useSSESubscription } from '../src/store/SSEContext';

function makeItem(id: string, text: string, position: number) {
  return {
    id,
    note_id: 'note-refresh',
    text,
    completed: false,
    position,
    parent_id: null,
    assigned_to: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function listNote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'note-refresh',
    user_id: 'u1',
    title: 'Packliste',
    content: '',
    note_type: 'list',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    checked_items_collapsed: false,
    is_shared: true,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    labels: [],
    shared_with: [],
    items: [makeItem('aaaaaaaaaaaaaaaaaaaaaa', 'Kraxxe', 0)],
    ...overrides,
  };
}

function itemTexts(getAllByTestId: (id: string) => { props: { value?: string } }[]): string[] {
  return getAllByTestId('list-item-text').map((node) => node.props.value ?? '');
}

describe('NoteEditorScreen remote refresh', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-refresh' } });
  });

  // The core bug: another user adds a checklist item to a shared note. The
  // update lands in the offline cache and re-runs the query, but the editor
  // kept its first-hydration snapshot, so the new item never appeared. A clean
  // editor must now re-hydrate from the refreshed note.
  it('reflects checklist items added by another user when the editor is clean', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote() });
    const { getAllByTestId, rerender } = await render(<NoteEditorScreen />);

    expect(itemTexts(getAllByTestId)).toEqual(['Kraxxe']);

    // Simulate the SSE-driven refetch: the cache now holds an extra item.
    const updated = listNote({
      items: [
        makeItem('aaaaaaaaaaaaaaaaaaaaaa', 'Kraxxe', 0),
        makeItem('bbbbbbbbbbbbbbbbbbbbbb', 'Kultur', 1),
      ],
      updated_at: '2026-01-01T00:05:00.000Z',
    });
    mockUseOfflineNote.mockReturnValue({ data: updated });
    await act(async () => {
      await rerender(<NoteEditorScreen />);
    });

    await waitFor(() => {
      expect(itemTexts(getAllByTestId)).toEqual(['Kraxxe', 'Kultur']);
    });
  });

  // The safety guard: when the local user has unsaved edits, an incoming remote
  // update must NOT clobber their in-progress work. The banner alone signals the
  // remote change; the editor keeps the dirty local state.
  it('does not clobber unsaved local edits when a remote update arrives', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote() });
    const { getByTestId, getAllByTestId, rerender } = await render(<NoteEditorScreen />);

    // Local user edits the title — this marks the editor dirty.
    await act(async () => {
      await fireEvent.changeText(getByTestId('note-title-input'), 'Packliste (mine)');
    });

    // A remote update arrives with a different title and an extra item.
    const updated = listNote({
      title: 'Packliste (theirs)',
      items: [
        makeItem('aaaaaaaaaaaaaaaaaaaaaa', 'Kraxxe', 0),
        makeItem('bbbbbbbbbbbbbbbbbbbbbb', 'Kultur', 1),
      ],
      updated_at: '2026-01-01T00:05:00.000Z',
    });
    mockUseOfflineNote.mockReturnValue({ data: updated });
    await act(async () => {
      await rerender(<NoteEditorScreen />);
    });

    // The local edit is preserved and the remote item was not merged in.
    expect(getByTestId('note-title-input').props.value).toBe('Packliste (mine)');
    expect(itemTexts(getAllByTestId)).toEqual(['Kraxxe']);
  });

  // The banner is now state-aware: a clean editor silently absorbs the remote
  // change (no banner), while a dirty editor — where the refresh is suppressed —
  // gets the warning banner as the only signal of the divergence.
  it('warns about a remote change only while the editor has unsaved edits', async () => {
    mockUseOfflineNote.mockReturnValue({ data: listNote() });
    const { getByTestId, queryByTestId } = await render(<NoteEditorScreen />);

    // The SSE hook is mocked; grab the latest handler the editor registered so
    // we can simulate an inbound "another user updated this note" event.
    const fireRemoteUpdate = () => {
      const calls = (useSSESubscription as jest.Mock).mock.calls;
      (calls[calls.length - 1][1] as () => void)();
    };

    // Clean editor: no banner (the change is auto-applied by the refresh effect).
    await act(async () => { fireRemoteUpdate(); });
    expect(queryByTestId('sync-toast')).toBeNull();

    // Introduce an unsaved local edit.
    await act(async () => {
      await fireEvent.changeText(getByTestId('note-title-input'), 'Packliste (mine)');
    });

    // Now a remote update surfaces the warning banner.
    await act(async () => { fireRemoteUpdate(); });
    expect(queryByTestId('sync-toast')).not.toBeNull();
  });
});
