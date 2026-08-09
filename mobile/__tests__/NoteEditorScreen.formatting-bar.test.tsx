import { Alert, Keyboard, Platform } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import { VALIDATION } from '@jot/shared';
import {
  mockUseRoute,
  mockNavigationAddListener,
  mockUseOfflineNote,
  mockShowToast,
} from './helpers/noteEditorScreenTestSetup';
import NoteEditorScreen from '../src/screens/NoteEditorScreen';

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    user_id: 'u1',
    note_type: 'text',
    title: '',
    content: '',
    pinned: false,
    archived: false,
    color: '#ffffff',
    checked_items_collapsed: false,
    labels: [],
    items: [],
    deleted_at: null,
    ...overrides,
  };
}

describe('NoteEditorScreen formatting bar', () => {
  const originalPlatform = Platform.OS;
  /** Every keyboard listener the screen (and its hooks) registered, by event. */
  const keyboardListeners = new Map<string, Array<() => void>>();

  const emitKeyboardEvent = async (event: string) => {
    await act(async () => {
      (keyboardListeners.get(event) ?? []).forEach((listener) => listener());
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    keyboardListeners.clear();
    mockNavigationAddListener.mockReturnValue(jest.fn());
    // A brand-new text note opens straight into the editable content input.
    mockUseRoute.mockReturnValue({ params: { noteId: null } });
    mockUseOfflineNote.mockReturnValue({ data: null });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, listener: () => void) => {
      keyboardListeners.set(event, [...(keyboardListeners.get(event) ?? []), listener]);
      return { remove: jest.fn() };
    }) as never);
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    jest.restoreAllMocks();
  });

  /** Renders the editor and returns helpers bound to the content input. */
  function renderEditor() {
    const utils = render(<NoteEditorScreen />);
    const input = () => utils.getByTestId('note-content-input');

    const type = async (text: string) => {
      await act(async () => {
        fireEvent.changeText(input(), text);
      });
    };

    const placeCaret = async (start: number, end = start) => {
      await act(async () => {
        fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start, end } } });
      });
    };

    const press = async (testID: string) => {
      await act(async () => {
        fireEvent.press(utils.getByTestId(testID));
      });
    };

    return { ...utils, input, type, placeCaret, press };
  }

  it('inserts bold markers at the caret and puts the caret between them', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('one\ntwo');
    await placeCaret(3); // end of the first line

    await press('format-bold-btn');

    expect(input().props.value).toBe('one****\ntwo');
    expect(input().props.selection).toEqual({ start: 5, end: 5 });
  });

  it('wraps the selected text and keeps it selected', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('make this bold');
    await placeCaret(5, 9); // "this"

    await press('format-bold-btn');

    expect(input().props.value).toBe('make **this** bold');
    expect(input().props.selection).toEqual({ start: 7, end: 11 });
  });

  it('unwraps when the same formatting is applied twice', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('make this italic');
    await placeCaret(5, 9);
    await press('format-italic-btn');
    expect(input().props.value).toBe('make *this* italic');

    // The selection prop reports where the caret went, mirroring the native input.
    await placeCaret(6, 10);
    await press('format-italic-btn');
    expect(input().props.value).toBe('make this italic');
  });

  it('strikes through the selection and clears it on a second press', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('buy milk');
    await placeCaret(4, 8); // "milk"

    await press('format-strikethrough-btn');
    expect(input().props.value).toBe('buy ~~milk~~');
    expect(input().props.selection).toEqual({ start: 6, end: 10 });

    await press('format-strikethrough-btn');
    expect(input().props.value).toBe('buy milk');
  });

  it('headings the caret line rather than the last line of the note', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('title\nbody\nmore');
    await placeCaret(2); // inside "title"

    await press('format-heading-btn');

    expect(input().props.value).toBe('## title\nbody\nmore');
  });

  it('cycles the heading level on repeated presses', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('title');
    await placeCaret(2);

    await press('format-heading-btn');
    expect(input().props.value).toBe('## title');

    await press('format-heading-btn');
    expect(input().props.value).toBe('### title');

    await press('format-heading-btn');
    expect(input().props.value).toBe('title');
  });

  it('bullets the caret line and toggles it back off', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('one\ntwo');
    await placeCaret(5); // inside "two"

    await press('format-bullet-btn');
    expect(input().props.value).toBe('one\n- two');

    await press('format-bullet-btn');
    expect(input().props.value).toBe('one\ntwo');
  });

  it('adds a checklist marker and steps it down to a bullet', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('milk');
    await placeCaret(4);

    await press('format-checkbox-btn');
    expect(input().props.value).toBe('- [ ] milk');

    await press('format-bullet-btn');
    expect(input().props.value).toBe('- milk');
  });

  it('continues a list when Enter is pressed at the end of an item', async () => {
    const { input, type, placeCaret } = renderEditor();

    await type('- one');
    await placeCaret(5);
    await type('- one\n'); // Enter

    expect(input().props.value).toBe('- one\n- ');
    expect(input().props.selection).toEqual({ start: 8, end: 8 });
  });

  it('ends the list when Enter is pressed on an empty item', async () => {
    const { input, type, placeCaret } = renderEditor();

    await type('- one\n- ');
    await placeCaret(8);
    await type('- one\n- \n'); // Enter

    expect(input().props.value).toBe('- one\n');
  });

  it('leaves ordinary typing untouched', async () => {
    const { input, type, placeCaret } = renderEditor();

    await type('plain');
    await placeCaret(5);
    await type('plain\n');

    expect(input().props.value).toBe('plain\n');
  });

  it('releases the forced caret once the input reports it landed', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('hi');
    await placeCaret(2);
    await press('format-bold-btn');
    expect(input().props.selection).toEqual({ start: 4, end: 4 });

    // The native input confirms the caret move; the prop goes uncontrolled again
    // so it cannot fight the user's next tap.
    await placeCaret(4);
    expect(input().props.selection).toBeUndefined();
  });

  it('does not force the caret when the edit leaves it where it already is', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    await type('- one');
    await placeCaret(0); // start of the line: the marker is removed after the caret

    await press('format-bullet-btn');

    expect(input().props.value).toBe('one');
    // Forcing {0,0} here would never be released — the input reports no
    // selection change — leaving the prop controlled with a stale value.
    expect(input().props.selection).toBeUndefined();
  });

  it('says why a formatting press did nothing at the length cap', async () => {
    const { input, type, placeCaret, press } = renderEditor();

    const full = 'x'.repeat(VALIDATION.CONTENT_MAX_LENGTH);
    await type(full);
    await placeCaret(full.length);

    await press('format-bold-btn');

    // The edit is rejected, but not silently.
    expect(input().props.value).toBe(full);
    expect(mockShowToast).toHaveBeenCalledWith('note.contentLimitReached', 'error');
  });

  it('keeps the newline but drops the marker when a list would exceed the cap', async () => {
    const { input, type, placeCaret } = renderEditor();

    // One character below the cap, ending in a list item: the newline still
    // fits, the "- " it would carry over does not.
    const base = `${'x'.repeat(VALIDATION.CONTENT_MAX_LENGTH - 7)}\n- one`;
    expect(base).toHaveLength(VALIDATION.CONTENT_MAX_LENGTH - 1);
    await type(base);
    await placeCaret(base.length);

    const typed = `${base}\n`;
    await type(typed);

    // The Enter survives; only the auto-continuation is given up.
    expect(input().props.value).toBe(typed);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('renders the bar on Android too', async () => {
    Platform.OS = 'android';
    const { getByTestId } = renderEditor();

    expect(getByTestId('format-bold-btn')).toBeTruthy();
    expect(getByTestId('format-checkbox-btn')).toBeTruthy();
  });

  it('drops the bar when the keyboard closes but keeps the action bar', async () => {
    Platform.OS = 'android';
    const { getByTestId, queryByTestId } = renderEditor();
    expect(getByTestId('format-bold-btn')).toBeTruthy();

    await emitKeyboardEvent('keyboardDidHide');

    // The formatting bar belongs to the keyboard; the action bar does not.
    expect(queryByTestId('format-bold-btn')).toBeNull();
    expect(getByTestId('toolbar-color-btn')).toBeTruthy();
    expect(getByTestId('content-preview')).toBeTruthy();
  });

  it('keeps the buttons out of the Android focus order', async () => {
    Platform.OS = 'android';
    const { getByTestId } = renderEditor();

    // A focusable button takes input focus from the content input on tap, which
    // hides the keyboard and so tears down the editor mid-edit.
    for (const id of ['format-bold-btn', 'format-italic-btn', 'format-strikethrough-btn', 'format-heading-btn', 'format-bullet-btn', 'format-checkbox-btn']) {
      expect(getByTestId(id).props.focusable).toBe(false);
    }
  });

  it('hides the bar when the note is not being edited', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1' } });
    mockUseOfflineNote.mockReturnValue({ data: makeNote({ content: 'Saved body' }) });

    const { queryByTestId, getByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('content-preview')).toBeTruthy();
    expect(queryByTestId('format-bold-btn')).toBeNull();
  });

  it('hides the bar on a read-only note', () => {
    mockUseRoute.mockReturnValue({ params: { noteId: 'note-1', readOnly: true } });
    mockUseOfflineNote.mockReturnValue({
      data: makeNote({ content: 'Deleted body', deleted_at: '2026-07-03T00:00:00Z' }),
    });

    const { queryByTestId } = render(<NoteEditorScreen />);

    expect(queryByTestId('format-bold-btn')).toBeNull();
  });
});
