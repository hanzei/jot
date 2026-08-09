import { render, act, fireEvent } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockUpdateMutateAsync,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// A deferred update mutation so a metadata PATCH can be held in flight while we
// simulate a stale refetch landing mid-request.
let mockResolveUpdate: (() => void) | null = null;

function textNote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'note-meta',
    user_id: 'u1',
    title: '',
    content: 'Hello',
    note_type: 'text',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    checked_items_collapsed: false,
    is_shared: false,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    labels: [],
    shared_with: [],
    items: [],
    ...overrides,
  };
}

describe('NoteEditorScreen metadata refresh guard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockResolveUpdate = null;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-meta' } });
    mockUpdateMutateAsync.mockImplementation(
      () => new Promise<Record<string, never>>((resolve) => {
        mockResolveUpdate = () => resolve({});
      }),
    );
  });

  // A stale refetch landing while a pin PATCH is in flight must not revert the
  // optimistic pin. useUpdateNote doesn't touch saveInFlightRef, so the refresh
  // effect relies on the dedicated metadataUpdateInFlightRef guard here.
  it('keeps an optimistic pin while the metadata PATCH is in flight', async () => {
    mockUseOfflineNote.mockReturnValue({ data: textNote() });
    const { getByTestId, rerender } = render(<NoteEditorScreen />);

    expect(getByTestId('toolbar-pin-btn').props.accessibilityLabel).toBe('note.pin');

    // Tap pin: sets the optimistic state and starts the (deferred) PATCH.
    await act(async () => {
      fireEvent.press(getByTestId('toolbar-pin-btn'));
    });
    expect(getByTestId('toolbar-pin-btn').props.accessibilityLabel).toBe('note.unpin');
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // A stale refetch (still pinned: false) arrives before the PATCH resolves.
    mockUseOfflineNote.mockReturnValue({
      data: textNote({ pinned: false, updated_at: '2026-01-01T00:05:00.000Z' }),
    });
    await act(async () => {
      rerender(<NoteEditorScreen />);
    });

    // The optimistic pin is preserved (guard blocked the refresh).
    expect(getByTestId('toolbar-pin-btn').props.accessibilityLabel).toBe('note.unpin');

    // Let the PATCH settle so no promise is left dangling.
    await act(async () => {
      mockResolveUpdate?.();
    });
  });
});
