import { render, fireEvent } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { Animated, StyleSheet } from 'react-native';
import { VALIDATION } from '@jot/shared';
import ListItem from '../src/components/ListItem';
import * as layoutAnimation from '../src/utils/layoutAnimation';
import type { Collaborator } from '@jot/shared';

const collaborators: Collaborator[] = [
  { userId: 'u1', username: 'alice', firstName: 'Alice' },
  { userId: 'u2', username: 'bob', firstName: 'Bob' },
];

// An editable row's rendered text is hidden from assistive technology on
// purpose — the input behind it is the row's real control and carries the value
// — so the queries for it have to opt in.
const HIDDEN = { includeHiddenElements: true } as const;

/** Every string in a rendered subtree, i.e. what the user actually reads. */
function visibleText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(visibleText).join('');
}

/**
 * The text of every tappable node inside an element — a link the user can
 * follow. Deduplicated, since a composite element and the host element it
 * renders both carry the handler and are both in the tree.
 */
function tappableTexts(node: ReactTestInstance | string): string[] {
  function walk(current: ReactTestInstance | string): string[] {
    if (typeof current === 'string') return [];
    const own = typeof current.props.onPress === 'function' ? [visibleText(current)] : [];
    return own.concat(current.children.flatMap(walk));
  }

  return [...new Set(walk(node))];
}

describe('ListItem', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders text and unchecked checkbox', () => {
    const { getByTestId } = render(
      <ListItem text="Buy milk" completed={false} />,
    );

    expect(getByTestId('list-item-text').props.value).toBe('Buy milk');
  });

  it('calls onToggle when checkbox pressed', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} onToggle={onToggle} />,
    );

    fireEvent.press(getByTestId('list-item-checkbox'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onChangeText when text changed', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} onChangeText={onChangeText} />,
    );

    fireEvent.changeText(getByTestId('list-item-text'), 'Updated task');
    expect(onChangeText).toHaveBeenCalledWith('Updated task');
  });

  it('calls onDelete when delete button pressed', () => {
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} onDelete={onDelete} />,
    );

    // The delete button only appears while the row is focused (selected).
    fireEvent(getByTestId('list-item-text'), 'focus');
    fireEvent.press(getByTestId('list-item-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('hides the delete button until the row is focused', () => {
    const { getByTestId, queryByTestId } = render(
      <ListItem text="Task" completed={false} onDelete={jest.fn()} />,
    );

    expect(queryByTestId('list-item-delete')).toBeNull();
    fireEvent(getByTestId('list-item-text'), 'focus');
    expect(queryByTestId('list-item-delete')).not.toBeNull();
  });

  it('reserves the delete button width with a spacer while unfocused', () => {
    // The delete button only renders while focused; a same-sized spacer must
    // take its place the rest of the time so the text input's width — and
    // therefore its line breaks — doesn't change when the row is selected.
    const { getByTestId, queryByTestId } = render(
      <ListItem text="Task" completed={false} onDelete={jest.fn()} />,
    );

    expect(queryByTestId('list-item-delete-spacer')).not.toBeNull();
    expect(queryByTestId('list-item-delete')).toBeNull();

    fireEvent(getByTestId('list-item-text'), 'focus');
    expect(queryByTestId('list-item-delete-spacer')).toBeNull();
    expect(queryByTestId('list-item-delete')).not.toBeNull();
  });

  // A read-only row is a display surface, so it renders the inline Markdown
  // subset. An editable row renders it too, and shows source for exactly as long
  // as it holds the caret (docs/specs/markdown-rendering.md §1.2).
  it('renders markdown in the read-only row', () => {
    const { getByTestId, queryByTestId } = render(
      <ListItem text="buy **milk**" completed={false} editable={false} />,
    );

    expect(queryByTestId('list-item-text')).toBeNull();
    expect(visibleText(getByTestId('list-item-text-readonly'))).toBe('buy milk');
  });

  describe('rendered/source swap', () => {
    it('renders markdown in an unfocused editable row', () => {
      const { getByTestId } = render(<ListItem text="buy **milk**" completed={false} />);

      expect(visibleText(getByTestId('list-item-text-rendered', HIDDEN))).toBe('buy milk');
      // Never unmounted, only taken out of flow: moving focus between two
      // mounted inputs is what keeps the software keyboard up, and everything
      // that reaches for a row imperatively goes through this field.
      expect(getByTestId('list-item-text').props.value).toBe('buy **milk**');
    });

    it('shows source while the row holds the caret, and renders again on blur', () => {
      const { getByTestId, queryByTestId } = render(<ListItem text="buy **milk**" completed={false} />);

      fireEvent(getByTestId('list-item-text'), 'focus');
      expect(queryByTestId('list-item-text-rendered', HIDDEN)).toBeNull();

      fireEvent(getByTestId('list-item-text'), 'blur');
      expect(queryByTestId('list-item-text-rendered', HIDDEN)).not.toBeNull();
    });

    it('does not swap a row whose text renders as itself', () => {
      // `buy milk` renders to `buy milk`, so the row keeps the always-live input
      // it has always had and pays for none of this.
      const { getByTestId, queryByTestId } = render(<ListItem text="buy milk" completed={false} />);

      expect(queryByTestId('list-item-text-rendered', HIDDEN)).toBeNull();
      expect(getByTestId('list-item-text').props.value).toBe('buy milk');
    });

    it('renders markdown in a completed row', () => {
      const { getByTestId } = render(<ListItem text="buy **milk**" completed={true} />);

      expect(visibleText(getByTestId('list-item-text-rendered', HIDDEN))).toBe('buy milk');
    });

    it('renders an editable row of links as inert text', () => {
      // One tap in an editable row already means "put the caret here", so
      // nothing inside it is separately tappable. A read-only row, which has no
      // caret to place, keeps its live links.
      const editable = render(<ListItem text="see [docs](https://example.com)" completed={false} />);
      const rendered = editable.getByTestId('list-item-text-rendered', HIDDEN);
      expect(visibleText(rendered)).toBe('see docs');
      // The container's own onPress is the caret placement, so only its
      // descendants are asked about here.
      expect(rendered.children.flatMap((child) => tappableTexts(child))).toEqual([]);

      const readOnly = render(
        <ListItem text="see [docs](https://example.com)" completed={false} editable={false} />,
      );
      expect(tappableTexts(readOnly.getByTestId('list-item-text-readonly'))).toEqual(['docs']);
    });

    it('holds the row in its current form for the length of a drag', () => {
      // Starting a drag must not change the row's height, whatever takes focus
      // off the field mid-gesture.
      const { getByTestId, queryByTestId, rerender } = render(
        <ListItem text="buy **milk**" completed={false} />,
      );

      fireEvent(getByTestId('list-item-text'), 'focus');
      rerender(<ListItem text="buy **milk**" completed={false} isActive />);
      fireEvent(getByTestId('list-item-text'), 'blur');
      expect(queryByTestId('list-item-text-rendered', HIDDEN)).toBeNull();

      // Dropped: the row settles into the form it should have been in all along.
      rerender(<ListItem text="buy **milk**" completed={false} />);
      expect(queryByTestId('list-item-text-rendered', HIDDEN)).not.toBeNull();
    });
  });

  describe('tap to edit', () => {
    // 10px per character on one 20px line, so a tap at x lands on character x/10.
    const lines = [{ x: 0, y: 0, width: 80, height: 20, text: 'buy milk' }];

    function tapRendered(x: number, measured = true) {
      const view = render(<ListItem text="buy **milk**" completed={false} />);
      const rendered = view.getByTestId('list-item-text-rendered', HIDDEN);
      if (measured) fireEvent(rendered, 'textLayout', { nativeEvent: { lines } });
      fireEvent.press(rendered, { nativeEvent: { locationX: x, locationY: 10 } });
      return view;
    }

    it('puts the caret where the tap pointed', () => {
      // Character 4 of `buy milk` is the `m`, which sits at 6 in the source.
      expect(tapRendered(40).getByTestId('list-item-text').props.selection).toEqual({ start: 6, end: 6 });
    });

    it('maps a tap before any markers straight through', () => {
      expect(tapRendered(0).getByTestId('list-item-text').props.selection).toEqual({ start: 0, end: 0 });
    });

    it('releases the forced caret once the input reports it landed', () => {
      // Otherwise the row would stay controlled at an offset that goes stale on
      // the next keystroke.
      const view = tapRendered(40);
      const input = view.getByTestId('list-item-text');
      fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 6, end: 6 } } });

      expect(view.getByTestId('list-item-text').props.selection).toBeUndefined();
    });

    it('forces nothing when the caret is already where the tap points', () => {
      // Unmeasured text falls back to the end of the source, which is where the
      // caret already is — and a forced selection the input never reports back
      // is one that never gets released.
      expect(tapRendered(40, false).getByTestId('list-item-text').props.selection).toBeUndefined();
    });
  });

  it('names the checkbox with the item words, not its markdown source', () => {
    const { getByTestId } = render(
      <ListItem text="buy **milk**" completed={false} editable={false} />,
    );

    const label = getByTestId('list-item-checkbox').props.accessibilityLabel as string;
    expect(label).toContain('buy milk');
    expect(label).not.toContain('**');
  });

  it('does not show delete button when not editable', () => {
    const { queryByTestId } = render(
      <ListItem text="Task" completed={false} editable={false} onDelete={jest.fn()} />,
    );

    expect(queryByTestId('list-item-delete')).toBeNull();
  });

  it('applies strikethrough style to completed items', () => {
    const { getByTestId } = render(
      <ListItem text="Done task" completed={true} />,
    );

    const textInput = getByTestId('list-item-text');
    expect(StyleSheet.flatten(textInput.props.style)?.textDecorationLine).toBe('line-through');
  });

  it('uses shared indent spacing for positive indent levels', () => {
    const { getByTestId } = render(
      <ListItem text="Indented task" completed={false} indentLevel={1} />,
    );

    const row = getByTestId('list-item-row');
    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(VALIDATION.INDENT_PX_PER_LEVEL);
  });

  it('clamps negative indent levels to zero', () => {
    const { getByTestId } = render(
      <ListItem text="Invalid indent task" completed={false} indentLevel={-2} />,
    );

    const row = getByTestId('list-item-row');
    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(0);
  });

  it('uses multiline text input for wrapping long text', () => {
    const { getByTestId } = render(
      <ListItem text="A very long task text that should wrap to the next line" completed={false} />,
    );

    expect(getByTestId('list-item-text').props.multiline).toBe(true);
  });

  it('shows assign button when shared with collaborators', () => {
    const onAssignPress = jest.fn();
    const { getByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={onAssignPress}
      />,
    );

    // The unassigned assign button only appears while the row is focused
    // (selected), matching the delete button.
    fireEvent(getByTestId('list-item-text'), 'focus');
    expect(getByTestId('list-item-assign')).toBeTruthy();
    fireEvent.press(getByTestId('list-item-assign'));
    expect(onAssignPress).toHaveBeenCalledTimes(1);
  });

  it('hides the unassigned assign button until the row is focused', () => {
    const { getByTestId, queryByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('list-item-assign')).toBeNull();
    fireEvent(getByTestId('list-item-text'), 'focus');
    expect(queryByTestId('list-item-assign')).not.toBeNull();
  });

  it('hides assign button when not shared', () => {
    const { queryByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={false}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('list-item-assign')).toBeNull();
  });

  it('hides assign button when no collaborators', () => {
    const { queryByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={[]}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('list-item-assign')).toBeNull();
  });

  it('shows assignee avatar when item is assigned', () => {
    const { getByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('list-item-assignee')).toBeTruthy();
  });

  it('hides unassigned placeholder for completed items', () => {
    const { queryByTestId } = render(
      <ListItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('list-item-assign')).toBeNull();
  });

  it('shows assignee avatar for completed items (read-only)', () => {
    const { getByTestId } = render(
      <ListItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('list-item-assignee')).toBeTruthy();
  });

  it('calls onSubmitEditing with the cursor position from the last selection change', () => {
    const onSubmitEditing = jest.fn();
    const { getByTestId } = render(
      <ListItem text="helloworld" completed={false} onSubmitEditing={onSubmitEditing} />,
    );

    const input = getByTestId('list-item-text');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    fireEvent(input, 'submitEditing');

    expect(onSubmitEditing).toHaveBeenCalledWith(5);
  });

  it('defaults the submit cursor position to the end of the current text', () => {
    const onSubmitEditing = jest.fn();
    const { getByTestId } = render(
      <ListItem text="helloworld" completed={false} onSubmitEditing={onSubmitEditing} />,
    );

    fireEvent(getByTestId('list-item-text'), 'submitEditing');

    expect(onSubmitEditing).toHaveBeenCalledWith('helloworld'.length);
  });

  describe('checkbox pop animation', () => {
    it('pops the checkbox on mount when popOnMount is set', () => {
      jest.spyOn(layoutAnimation, 'isReduceMotionEnabledSync').mockReturnValue(false);
      const springSpy = jest.spyOn(Animated, 'spring');

      render(<ListItem text="Done" completed={true} popOnMount />);

      expect(springSpy).toHaveBeenCalledTimes(1);
      expect(springSpy.mock.calls[0]![1]).toMatchObject({ toValue: 1 });
    });

    it('does not pop when popOnMount is not set', () => {
      jest.spyOn(layoutAnimation, 'isReduceMotionEnabledSync').mockReturnValue(false);
      const springSpy = jest.spyOn(Animated, 'spring');

      render(<ListItem text="Done" completed={true} />);

      expect(springSpy).not.toHaveBeenCalled();
    });

    it('does not pop when Reduce Motion is enabled', () => {
      jest.spyOn(layoutAnimation, 'isReduceMotionEnabledSync').mockReturnValue(true);
      const springSpy = jest.spyOn(Animated, 'spring');

      render(<ListItem text="Done" completed={true} popOnMount />);

      expect(springSpy).not.toHaveBeenCalled();
    });
  });
});
