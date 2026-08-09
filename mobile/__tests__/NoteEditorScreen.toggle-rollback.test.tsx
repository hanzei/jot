import { render, act, waitFor } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockToggleItemCompletedMutateAsync as mockToggleMutateAsync,
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

    const { getAllByTestId, getByText, UNSAFE_getAllByProps } = render(<NoteEditorScreen />);

    // Both items start unchecked, so both render in the active list:
    // [0] = Parent, [1] = Child. The checkbox composites carry onPress (= the
    // row's toggle handler); the testID host node does not.
    // Each checkbox surfaces as multiple nodes sharing one onPress reference;
    // dedupe by handler identity to get one entry per row (Parent, then Child).
    const seenToggles = new Set<unknown>();
    const checkboxes = UNSAFE_getAllByProps({ accessibilityRole: 'checkbox' })
      .filter((node) => typeof node.props.onPress === 'function')
      .filter((node) => {
        if (seenToggles.has(node.props.onPress)) return false;
        seenToggles.add(node.props.onPress);
        return true;
      });
    expect(checkboxes).toHaveLength(2);

    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Invoke both toggles in one act() so the parent toggle runs against the
    // child's optimistic state before a re-render — reproducing a rapid
    // double-tap. onPress wraps handleItemCompletedToggle(id, !completed).
    await act(async () => {
      checkboxes[1]!.props.onPress(); // check Child (request succeeds)
      checkboxes[0]!.props.onPress(); // check Parent (request fails)
    });

    // Parent rolled back to unchecked; Child stays checked.
    await waitFor(() => {
      expect(getByText('1 completed items')).toBeTruthy();
    });
    expect(getAllByTestId('icon-SquareCheck')).toHaveLength(1); // only Child completed
    expect(getAllByTestId('icon-Square')).toHaveLength(1); // only Parent active

    expect(mockToggleMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: CHILD_ID, completed: true }),
    );
    expect(mockToggleMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: PARENT_ID, completed: true }),
    );
  });
});
