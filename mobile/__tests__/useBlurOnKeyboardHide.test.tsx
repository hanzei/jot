import { renderHook, act } from '@testing-library/react-native';
import { Keyboard, Platform, TextInput } from 'react-native';
import type { EmitterSubscription } from 'react-native';
import { useBlurOnKeyboardHide } from '../src/hooks/useBlurOnKeyboardHide';

function setPlatformOS(os: typeof Platform.OS) {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}

describe('useBlurOnKeyboardHide', () => {
  let originalOS: typeof Platform.OS;
  let listeners: Record<string, () => void>;
  let blur: jest.Mock;
  let remove: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    originalOS = Platform.OS;
    listeners = {};
    blur = jest.fn();
    remove = jest.fn();
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
      listeners[event] = cb;
      return { remove } as unknown as EmitterSubscription;
    }) as never);
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue({ blur } as never);
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  });

  afterEach(() => {
    setPlatformOS(originalOS);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('blurs the focused input when Android hides the keyboard', async () => {
    setPlatformOS('android');
    await renderHook(() => useBlurOnKeyboardHide());

    await act(async () => {
      listeners.keyboardDidHide?.();
      jest.advanceTimersByTime(100);
    });

    expect(blur).toHaveBeenCalledTimes(1);
  });

  it('tolerates no focused input', async () => {
    setPlatformOS('android');
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(null as never);
    await renderHook(() => useBlurOnKeyboardHide());

    await act(async () => {
      listeners.keyboardDidHide?.();
      jest.advanceTimersByTime(100);
    });

    expect(blur).not.toHaveBeenCalled();
  });

  it('leaves the input alone when the keyboard reopens straight away', async () => {
    setPlatformOS('android');
    const isVisible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    await renderHook(() => useBlurOnKeyboardHide());

    await act(async () => {
      listeners.keyboardDidHide?.();
      isVisible.mockReturnValue(true);
      jest.advanceTimersByTime(100);
    });

    expect(blur).not.toHaveBeenCalled();
  });

  it('does nothing on iOS', async () => {
    setPlatformOS('ios');
    await renderHook(() => useBlurOnKeyboardHide());

    expect(Keyboard.addListener).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount', async () => {
    setPlatformOS('android');
    const { unmount } = await renderHook(() => useBlurOnKeyboardHide());

    await unmount();

    expect(remove).toHaveBeenCalledTimes(1);
  });
});
