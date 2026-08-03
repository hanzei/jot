import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import { VALIDATION } from '@jot/shared';
import ListItem from '../src/components/ListItem';
import * as layoutAnimation from '../src/utils/layoutAnimation';
import type { Collaborator } from '@jot/shared';

const collaborators: Collaborator[] = [
  { userId: 'u1', username: 'alice', firstName: 'Alice' },
  { userId: 'u2', username: 'bob', firstName: 'Bob' },
];

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
  // subset; an editable row is an input and keeps showing its source. Rendering
  // in the editable row is #824.
  it('renders markdown in the read-only row', () => {
    const { getByTestId, queryByTestId } = render(
      <ListItem text="buy **milk**" completed={false} editable={false} />,
    );

    expect(queryByTestId('list-item-text')).toBeNull();
    const rendered = getByTestId('list-item-text-readonly');
    const visible = (function text(node: unknown): string {
      if (typeof node === 'string') return node;
      if (!node || typeof node !== 'object') return '';
      const children = (node as { props?: { children?: unknown } }).props?.children;
      if (Array.isArray(children)) return children.map(text).join('');
      return text(children);
    })(rendered);
    expect(visible).toBe('buy milk');
  });

  it('keeps the editable row showing markdown source', () => {
    const { getByTestId, queryByTestId } = render(
      <ListItem text="buy **milk**" completed={false} />,
    );

    expect(getByTestId('list-item-text').props.value).toBe('buy **milk**');
    expect(queryByTestId('list-item-text-readonly')).toBeNull();
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
    const flatStyle = Array.isArray(textInput.props.style)
      ? Object.assign({}, ...textInput.props.style)
      : textInput.props.style;
    expect(flatStyle.textDecorationLine).toBe('line-through');
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
      expect(springSpy.mock.calls[0][1]).toMatchObject({ toValue: 1 });
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
