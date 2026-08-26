import { Platform } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockShowToast,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

// The formatting bar over a list note's rows. It carries the inline three only:
// an item is lexed as inline content, so a heading/bullet/checkbox button would
// write source that renders as itself (docs/specs/markdown-rendering.md §2.1).
//
// Android is the platform under test throughout, because that is where the bar
// is an ordinary view in the tree. On iOS the same content lives inside an
// InputAccessoryView, which react-test-renderer does not attach to a keyboard.
describe('NoteEditorScreen list-item formatting bar', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
    mockNavigationAddListener.mockReturnValue(jest.fn());
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    jest.restoreAllMocks();
  });

  /** A new list note with one row, focused, and helpers bound to that row. */
  async function renderListEditor() {
    const utils = await render(<NoteEditorScreen />);

    await fireEvent.press(utils.getByTestId('toggle-note-type'));
    await fireEvent.press(utils.getByTestId('add-list-item'));

    const row = () => utils.getAllByTestId('list-item-text')[0]!;

    const focus = async () => {
      await act(async () => {
        await fireEvent(row(), 'focus', { nativeEvent: {} });
      });
    };

    const type = async (text: string) => {
      await act(async () => {
        await fireEvent.changeText(row(), text);
      });
    };

    const placeCaret = async (start: number, end = start) => {
      await act(async () => {
        await fireEvent(row(), 'selectionChange', { nativeEvent: { selection: { start, end } } });
      });
    };

    const press = async (testID: string) => {
      await act(async () => {
        await fireEvent.press(utils.getByTestId(testID));
      });
    };

    await focus();
    return { ...utils, row, focus, type, placeCaret, press };
  }

  it('carries the inline actions and none of the block ones', async () => {
    const { getByTestId, queryByTestId } = await renderListEditor();

    expect(getByTestId('format-bold-btn')).toBeTruthy();
    expect(getByTestId('format-italic-btn')).toBeTruthy();
    expect(getByTestId('format-strikethrough-btn')).toBeTruthy();

    expect(queryByTestId('format-heading-btn')).toBeNull();
    expect(queryByTestId('format-bullet-btn')).toBeNull();
    expect(queryByTestId('format-checkbox-btn')).toBeNull();
  });

  it('wraps the selected item text and keeps it selected', async () => {
    const { row, type, placeCaret, press } = await renderListEditor();

    await type('buy milk');
    await placeCaret(4, 8); // "milk"

    await press('format-bold-btn');

    expect(row().props.value).toBe('buy **milk**');
    expect(row().props.selection).toEqual({ start: 6, end: 10 });
  });

  it('unwraps a marker the selection already carries', async () => {
    const { row, type, placeCaret, press } = await renderListEditor();

    await type('buy ~~milk~~');
    await placeCaret(6, 10);

    await press('format-strikethrough-btn');

    expect(row().props.value).toBe('buy milk');
  });

  it('parks the caret between the markers when nothing is selected', async () => {
    const { row, type, placeCaret, press } = await renderListEditor();

    await type('milk');
    await placeCaret(4);

    await press('format-italic-btn');

    expect(row().props.value).toBe('milk**');
    expect(row().props.selection).toEqual({ start: 5, end: 5 });
  });

  it('drops the press at the item cap rather than truncating the text', async () => {
    const { row, type, placeCaret, press } = await renderListEditor();

    const atCap = 'x'.repeat(VALIDATION.ITEM_TEXT_MAX_LENGTH);
    await type(atCap);
    await placeCaret(0, VALIDATION.ITEM_TEXT_MAX_LENGTH);

    await press('format-bold-btn');

    expect(row().props.value).toBe(atCap);
    expect(mockShowToast).toHaveBeenCalledWith('note.itemLimitReached', 'error');
  });

  it('keeps the buttons out of the Android focus order', async () => {
    const { getByTestId } = await renderListEditor();

    // A focusable button takes input focus from the row on tap, which hides the
    // keyboard — and the row treats losing the caret as leaving edit mode.
    for (const id of ['format-bold-btn', 'format-italic-btn', 'format-strikethrough-btn']) {
      expect(getByTestId(id).props.focusable).toBe(false);
    }
  });

  it('shows the bar only while a row holds the caret', async () => {
    const { row, queryByTestId, getByTestId } = await renderListEditor();

    expect(getByTestId('format-bold-btn')).toBeTruthy();

    await act(async () => {
      await fireEvent(row(), 'blur');
    });
    // The clear is deferred (ITEM_BLUR_SETTLE_MS) so a tap from one row to the
    // next does not flash the bar away and back. Real timers here, so wait it out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(queryByTestId('format-bold-btn')).toBeNull();
  });

  it('leaves the text note bar with its full button set', async () => {
    const utils = await render(<NoteEditorScreen />);

    await act(async () => {
      await fireEvent.changeText(utils.getByTestId('note-content-input'), 'body');
    });

    expect(utils.getByTestId('format-heading-btn')).toBeTruthy();
    expect(utils.getByTestId('format-bullet-btn')).toBeTruthy();
    expect(utils.getByTestId('format-checkbox-btn')).toBeTruthy();
  });
});
