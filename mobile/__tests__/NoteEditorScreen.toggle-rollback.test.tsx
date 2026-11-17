import { Platform } from 'react-native';
import { render, act, fireEvent, waitFor } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockToggleItemCompletedMutateAsync as mockToggleMutateAsync,
  mockUpdateItemMutateAsync,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

const PARENT_ID = 'pppppppppppppppppppppp';
const CHILD_ID = 'cccccccccccccccccccccc';

function listNoteWithParentAndChild() {
  return {
    id: 'note-rollback',
    user_id: 'u1',
    title: 'Trip',
    content: '',
    note_type: 'list',
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
    items: [
      {
        id: PARENT_ID,
        note_id: 'note-rollback',
        text: 'Parent',
        completed: false,
        position: 0,
        parent_id: null,
        assigned_to: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: CHILD_ID,
        note_id: 'note-rollback',
        text: 'Child',
        completed: false,
        position: 1,
        parent_id: PARENT_ID,
        assigned_to: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('NoteEditorScreen toggle rollback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-rollback' } });
    mockUseOfflineNote.mockReturnValue({ data: listNoteWithParentAndChild() });
  });

  // A child toggle (succeeds) immediately followed — before the first toggle
  // re-renders — by a parent toggle whose request fails. The parent toggle must
  // capture the child's *current* completed state, so its rollback restores only
  // the parent and leaves the child checked. A stale snapshot would revert the
  // child too. The two onPress handlers are invoked inside a single act() so the
  // second runs against the same un-rendered optimistic state a rapid double-tap
  // produces on device.
  it('keeps a sibling toggle when an overlapping parent toggle fails', async () => {
    mockToggleMutateAsync.mockImplementation(
      ({ itemId, completed }: { itemId: string; completed: boolean }) => {
        if (itemId === PARENT_ID) {
          return Promise.reject(new Error('toggle failed'));
        }
        return Promise.resolve([{ id: itemId, completed }]);
      },
    );

    const { getAllByTestId, getByText } = await render(<NoteEditorScreen />);

    // Both items start unchecked, so both render in the active list:
    // [0] = Parent, [1] = Child.
    const checkboxes = getAllByTestId('list-item-checkbox');
    expect(checkboxes).toHaveLength(2);

    // Invoke both toggles synchronously inside one act() so the parent toggle
    // runs against the child's optimistic state before a re-render —
    // reproducing a rapid double-tap. `fireEvent.press` won't do here: it's
    // async and wraps its own act() internally, so two calls without an
    // await between them are overlapping act() calls (React warns and it's
    // unsupported) rather than the same-tick dispatch this test needs.
    // `onClick` is the Pressability-config handler these checkboxes render
    // with (react-native/Libraries/Pressability/Pressability.js) — calling it
    // directly re-creates the pre-v14 test's direct-handler-invocation
    // approach without going through fireEvent's async wrapping.
    const press = (checkbox: (typeof checkboxes)[number]) =>
      (checkbox.props as { onClick?: () => void }).onClick?.();
    await act(() => {
      press(checkboxes[1]!); // check Child (request succeeds)
      press(checkboxes[0]!); // check Parent (request fails)
    });

    // Parent rolled back to unchecked; Child stays checked.
    await waitFor(() => {
      expect(getByText('1 completed items')).toBeTruthy();
    });
    expect(getAllByTestId('icon-SquareCheck')).toHaveLength(1); // only Child completed
    // Parent is active; the second Square is its ghost header above the
    // completed Child.
    expect(getAllByTestId('icon-Square')).toHaveLength(2);

    expect(mockToggleMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: CHILD_ID, completed: true }),
    );
    expect(mockToggleMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: PARENT_ID, completed: true }),
    );
  });
});

describe('NoteEditorScreen toggle with a save pending', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    // The item formatting bar, whose indent button this test uses, is an
    // ordinary view in the tree on Android only.
    Platform.OS = 'android';
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-rollback' } });
    const note = listNoteWithParentAndChild();
    // Both rows start top-level; the test indents the second under the first.
    note.items[1]!.parent_id = null;
    mockUseOfflineNote.mockReturnValue({ data: note });
    mockUpdateItemMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
    Platform.OS = originalPlatform;
    jest.restoreAllMocks();
  });

  // The toggle cancels the debounced save so it cannot race the toggle's own
  // write. That save held the indent, and the toggle's write leaves the
  // child's completed flag to it too: it cascades by the stored hierarchy,
  // where the child is still top-level. Both must still be saved once the
  // toggle settles, not only on the next edit or on exit.
  it('saves an indent made just before a toggle, with the cascaded completed flag', async () => {
    jest.useFakeTimers();
    // The local write commits the parent only: SQLite does not know the child
    // is nested under it yet.
    mockToggleMutateAsync.mockResolvedValue([PARENT_ID]);

    const { getAllByTestId, getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent(getAllByTestId('list-item-text')[1]!, 'focus', { nativeEvent: {} });
    });
    await act(async () => {
      await fireEvent.press(getByTestId('format-indent-btn'));
    });

    // Check the parent before the indent's debounced save fires.
    await act(async () => {
      await fireEvent.press(getAllByTestId('list-item-checkbox')[0]!);
    });
    expect(mockToggleMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: PARENT_ID, completed: true }),
    );
    expect(mockUpdateItemMutateAsync).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(VALIDATION.AUTO_SAVE_TIMEOUT_MS); });

    expect(mockUpdateItemMutateAsync).toHaveBeenCalledWith({
      noteId: 'note-rollback',
      itemId: CHILD_ID,
      data: { parent_id: PARENT_ID, completed: true },
    });
    // The parent's flag is the toggle's: the save does not send it again.
    expect(mockUpdateItemMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('does not arm a save after a toggle when nothing is unsaved', async () => {
    jest.useFakeTimers();
    mockToggleMutateAsync.mockResolvedValue([PARENT_ID, CHILD_ID]);

    const { getAllByTestId } = await render(<NoteEditorScreen />);
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');

    await act(async () => {
      await fireEvent.press(getAllByTestId('list-item-checkbox')[0]!);
    });

    expect(mockToggleMutateAsync).toHaveBeenCalledTimes(1);
    // No debounced save was armed once the toggle settled.
    const autosaves = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === VALIDATION.AUTO_SAVE_TIMEOUT_MS);
    expect(autosaves).toHaveLength(0);
  });
});
