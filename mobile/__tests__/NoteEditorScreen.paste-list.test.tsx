import { render, fireEvent, waitFor } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockCreateMutateAsync,
  mockUpdateMutateAsync,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

describe('NoteEditorScreen markdown list paste', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null, initialNoteType: 'list' } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    mockCreateMutateAsync.mockResolvedValue({ id: 'server-1', note_type: 'list', title: '' });
    mockUpdateMutateAsync.mockResolvedValue({});
  });

  it('strips markdown list/checkbox markers and carries completed state when pasting a list', async () => {
    const { getByTestId, getAllByTestId } = await render(<NoteEditorScreen />);

    await fireEvent.press(getByTestId('add-list-item'));

    const input = getAllByTestId('list-item-text')[0]!;
    await fireEvent.changeText(input, '- [ ] too\n- [x] bar');

    await waitFor(() => {
      const inputs = getAllByTestId('list-item-text');
      expect(inputs.map((el) => el.props.value)).toEqual(['too', 'bar']);
    });

    const checkboxes = getAllByTestId('list-item-checkbox');
    expect(checkboxes.map((cb) => cb.props.accessibilityState.checked)).toEqual([false, true]);
  });

  it('strips markers and stays completed when pasting multiple lines into a completed item', async () => {
    const existingNote = {
      id: 'note-paste-completed',
      user_id: 'u1',
      title: 'Paste into completed item',
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
          id: 'completed-item',
          note_id: 'note-paste-completed',
          text: 'old text',
          completed: true,
          position: 0,
          parent_id: null,
          assigned_to: '',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    mockUseRoute.mockReturnValue({ params: { noteId: 'note-paste-completed' } });
    mockUseOfflineNote.mockReturnValue({ data: existingNote });

    const { getByTestId, getAllByTestId } = await render(<NoteEditorScreen />);

    expect(getByTestId('checked-items-section')).toBeTruthy();

    const input = getAllByTestId('list-item-text')[0]!;
    await fireEvent.changeText(input, '- [ ] too\n- [x] bar');

    // A completed item merges pasted lines into its single line rather than
    // splitting into new items, so both markers should be stripped and the
    // item should stay in the completed section either way.
    await waitFor(() => {
      const inputs = getAllByTestId('list-item-text');
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.props.value).toBe('too bar');
    });

    const checkboxes = getAllByTestId('list-item-checkbox');
    expect(checkboxes.map((cb) => cb.props.accessibilityState.checked)).toEqual([true]);
  });
});
