import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { PanResponder, StyleSheet } from 'react-native';
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native';
import { VALIDATION } from '@jot/shared';
import TodoItem from '../src/components/TodoItem';
import type { Collaborator } from '@jot/shared';

const collaborators: Collaborator[] = [
  { userId: 'u1', username: 'alice', firstName: 'Alice' },
  { userId: 'u2', username: 'bob', firstName: 'Bob' },
];
const gestureEvent = {} as GestureResponderEvent;
function createGestureState(dx: number, dy: number): PanResponderGestureState {
  return {
    stateID: 0,
    moveX: 0,
    moveY: 0,
    x0: 0,
    y0: 0,
    dx,
    dy,
    vx: 0,
    vy: 0,
    numberActiveTouches: 1,
    _accountsForMovesUpTo: 0,
  };
}

describe('TodoItem', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function getPanResponderConfig(createSpy: jest.SpiedFunction<typeof PanResponder.create>, callsBefore: number) {
    return createSpy.mock.calls
      .slice(callsBefore)
      .map(([config]) => config)
      .find((config) => typeof config.onPanResponderRelease === 'function');
  }

  it('renders text and unchecked checkbox', () => {
    const { getByTestId } = render(
      <TodoItem text="Buy milk" completed={false} />,
    );

    expect(getByTestId('todo-item-text').props.value).toBe('Buy milk');
  });

  it('calls onToggle when checkbox pressed', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <TodoItem text="Task" completed={false} onToggle={onToggle} />,
    );

    fireEvent.press(getByTestId('todo-item-checkbox'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onChangeText when text changed', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <TodoItem text="Task" completed={false} onChangeText={onChangeText} />,
    );

    fireEvent.changeText(getByTestId('todo-item-text'), 'Updated task');
    expect(onChangeText).toHaveBeenCalledWith('Updated task');
  });

  it('calls onDelete when delete button pressed', () => {
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <TodoItem text="Task" completed={false} onDelete={onDelete} />,
    );

    fireEvent.press(getByTestId('todo-item-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not show delete button when not editable', () => {
    const { queryByTestId } = render(
      <TodoItem text="Task" completed={false} editable={false} onDelete={jest.fn()} />,
    );

    expect(queryByTestId('todo-item-delete')).toBeNull();
  });

  it('applies strikethrough style to completed items', () => {
    const { getByTestId } = render(
      <TodoItem text="Done task" completed={true} />,
    );

    const textInput = getByTestId('todo-item-text');
    const flatStyle = Array.isArray(textInput.props.style)
      ? Object.assign({}, ...textInput.props.style)
      : textInput.props.style;
    expect(flatStyle.textDecorationLine).toBe('line-through');
  });

  it('uses shared indent spacing for positive indent levels', () => {
    const { getByTestId } = render(
      <TodoItem text="Indented task" completed={false} indentLevel={1} />,
    );

    const row = getByTestId('todo-item-row');
    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(VALIDATION.INDENT_PX_PER_LEVEL);
  });

  it('clamps negative indent levels to zero', () => {
    const { getByTestId } = render(
      <TodoItem text="Invalid indent task" completed={false} indentLevel={-2} />,
    );

    const row = getByTestId('todo-item-row');
    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(0);
  });

  it('uses multiline text input for wrapping long text', () => {
    const { getByTestId } = render(
      <TodoItem text="A very long task text that should wrap to the next line" completed={false} />,
    );

    expect(getByTestId('todo-item-text').props.multiline).toBe(true);
  });

  it('calls onIndent with +1 for right swipe beyond threshold', () => {
    const onIndent = jest.fn();
    const createSpy = jest.spyOn(PanResponder, 'create');
    const callsBefore = createSpy.mock.calls.length;
    render(<TodoItem text="Task" completed={false} onIndent={onIndent} />);
    const config = getPanResponderConfig(createSpy, callsBefore);
    expect(config).toBeDefined();
    config?.onPanResponderRelease?.(gestureEvent, createGestureState(60, 0));
    expect(onIndent).toHaveBeenCalledWith(1);
  });

  it('calls onIndent with -1 for left swipe beyond threshold', () => {
    const onIndent = jest.fn();
    const createSpy = jest.spyOn(PanResponder, 'create');
    const callsBefore = createSpy.mock.calls.length;
    render(<TodoItem text="Task" completed={false} onIndent={onIndent} />);
    const config = getPanResponderConfig(createSpy, callsBefore);
    expect(config).toBeDefined();
    config?.onPanResponderRelease?.(gestureEvent, createGestureState(-60, 0));
    expect(onIndent).toHaveBeenCalledWith(-1);
  });

  it('does not call onIndent for short horizontal swipes', () => {
    const onIndent = jest.fn();
    const createSpy = jest.spyOn(PanResponder, 'create');
    const callsBefore = createSpy.mock.calls.length;
    render(<TodoItem text="Task" completed={false} onIndent={onIndent} />);
    const config = getPanResponderConfig(createSpy, callsBefore);
    expect(config).toBeDefined();
    config?.onPanResponderRelease?.(gestureEvent, createGestureState(20, 0));
    expect(onIndent).not.toHaveBeenCalled();
  });

  it('does not call onIndent for mostly vertical swipes', () => {
    const onIndent = jest.fn();
    const createSpy = jest.spyOn(PanResponder, 'create');
    const callsBefore = createSpy.mock.calls.length;
    render(<TodoItem text="Task" completed={false} onIndent={onIndent} />);
    const config = getPanResponderConfig(createSpy, callsBefore);
    expect(config).toBeDefined();
    config?.onPanResponderRelease?.(gestureEvent, createGestureState(60, 80));
    expect(onIndent).not.toHaveBeenCalled();
  });

  it('does not call onIndent when item is not editable', () => {
    const onIndent = jest.fn();
    const createSpy = jest.spyOn(PanResponder, 'create');
    const callsBefore = createSpy.mock.calls.length;
    render(<TodoItem text="Task" completed={false} editable={false} onIndent={onIndent} />);
    const config = getPanResponderConfig(createSpy, callsBefore);
    expect(config).toBeDefined();
    config?.onPanResponderRelease?.(gestureEvent, createGestureState(60, 0));
    expect(onIndent).not.toHaveBeenCalled();
  });

  it('shows assign button when shared with collaborators', () => {
    const onAssignPress = jest.fn();
    const { getByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={onAssignPress}
      />,
    );

    expect(getByTestId('todo-item-assign')).toBeTruthy();
    fireEvent.press(getByTestId('todo-item-assign'));
    expect(onAssignPress).toHaveBeenCalledTimes(1);
  });

  it('hides assign button when not shared', () => {
    const { queryByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={false}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('todo-item-assign')).toBeNull();
  });

  it('hides assign button when no collaborators', () => {
    const { queryByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={[]}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('todo-item-assign')).toBeNull();
  });

  it('shows assignee avatar when item is assigned', () => {
    const { getByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('todo-item-assignee')).toBeTruthy();
  });

  it('hides unassigned placeholder for completed items', () => {
    const { queryByTestId } = render(
      <TodoItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('todo-item-assign')).toBeNull();
  });

  it('shows assignee avatar for completed items (read-only)', () => {
    const { getByTestId } = render(
      <TodoItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('todo-item-assignee')).toBeTruthy();
  });
});
