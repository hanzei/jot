import { render, fireEvent, act } from '@testing-library/react-native';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';
import { openUrl } from '../src/utils/openUrl';

jest.mock('../src/utils/openUrl', () => ({ openUrl: jest.fn().mockResolvedValue(undefined) }));

// The open note renders live links (docs/specs/markdown-rendering.md §1.1), and
// its read mode sits inside a pressable that opens the editor. Following a link
// must not also do that — the webapp had exactly this bug (#1185).

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    note_type: 'text',
    title: '',
    content: 'Reading list: [docs](https://example.com/docs)',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    ...overrides,
  };
}

describe('NoteEditorScreen read-mode links', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: makeNote() });
  });

  it('opens a tapped link without entering edit mode', async () => {
    const { getByText, queryByTestId, getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.press(getByText('docs'));
    });

    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
    expect(queryByTestId('note-content-input')).toBeNull();
    expect(getByTestId('content-preview')).toBeTruthy();
  });

  it('still opens the editor when the text around the link is tapped', async () => {
    const { getByTestId } = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.press(getByTestId('content-preview'));
    });

    expect(openUrl).not.toHaveBeenCalled();
    expect(getByTestId('note-content-input')).toBeTruthy();
  });
});
