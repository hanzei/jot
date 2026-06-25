import { renderHook, act } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import type { EmitterSubscription } from 'react-native';
import { useKeyboardHeight } from '../src/hooks/useKeyboardHeight';

type Listener = (event: { endCoordinates?: { height: number } }) => void;

describe('useKeyboardHeight', () => {
  let listeners: Record<string, Listener>;

  beforeEach(() => {
    listeners = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation((event, cb) => {
      listeners[event] = cb as unknown as Listener;
      return { remove: jest.fn() } as unknown as EmitterSubscription;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Default test platform is iOS, so the hook subscribes to the will* events.
  it('starts at 0 while the keyboard is hidden', () => {
    const { result } = renderHook(() => useKeyboardHeight());
    expect(result.current).toBe(0);
  });

  it('reports the keyboard height when it appears', () => {
    const { result } = renderHook(() => useKeyboardHeight());
    act(() => {
      listeners.keyboardWillShow({ endCoordinates: { height: 320 } });
    });
    expect(result.current).toBe(320);
  });

  it('resets to 0 when the keyboard hides', () => {
    const { result } = renderHook(() => useKeyboardHeight());
    act(() => {
      listeners.keyboardWillShow({ endCoordinates: { height: 320 } });
    });
    act(() => {
      listeners.keyboardWillHide({});
    });
    expect(result.current).toBe(0);
  });

  it('falls back to 0 when the event has no coordinates', () => {
    const { result } = renderHook(() => useKeyboardHeight());
    act(() => {
      listeners.keyboardWillShow({});
    });
    expect(result.current).toBe(0);
  });

  it('removes its listeners on unmount', () => {
    const removes: jest.Mock[] = [];
    (Keyboard.addListener as jest.Mock).mockImplementation(() => {
      const remove = jest.fn();
      removes.push(remove);
      return { remove } as unknown as EmitterSubscription;
    });
    const { unmount } = renderHook(() => useKeyboardHeight());
    unmount();
    expect(removes).toHaveLength(2);
    removes.forEach((remove) => expect(remove).toHaveBeenCalled());
  });
});
