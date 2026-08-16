import { renderHook, act } from '@testing-library/react-native';
import { Keyboard, Platform } from 'react-native';
import type { EmitterSubscription } from 'react-native';
import { useKeyboardHeight } from '../src/hooks/useKeyboardHeight';

type Listener = (event: { endCoordinates?: { height: number } }) => void;

// The hook subscribes to the will* events on iOS and the did* events on Android,
// so exercise both platforms to cover each branch.
const PLATFORMS = [
  { os: 'ios' as const, showEvent: 'keyboardWillShow', hideEvent: 'keyboardWillHide' },
  { os: 'android' as const, showEvent: 'keyboardDidShow', hideEvent: 'keyboardDidHide' },
];

function setPlatformOS(os: typeof Platform.OS) {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}

describe('useKeyboardHeight', () => {
  let listeners: Record<string, Listener>;
  let originalOS: typeof Platform.OS;

  beforeEach(() => {
    originalOS = Platform.OS;
    listeners = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation((event, cb) => {
      listeners[event] = cb as unknown as Listener;
      return { remove: jest.fn() } as unknown as EmitterSubscription;
    });
  });

  afterEach(() => {
    setPlatformOS(originalOS);
    jest.restoreAllMocks();
  });

  describe.each(PLATFORMS)('on $os', ({ os, showEvent, hideEvent }) => {
    beforeEach(() => {
      setPlatformOS(os);
    });

    it('starts at 0 while the keyboard is hidden', async () => {
      const { result } = await renderHook(() => useKeyboardHeight());
      expect(result.current).toBe(0);
    });

    it(`reports the keyboard height on ${showEvent}`, async () => {
      const { result } = await renderHook(() => useKeyboardHeight());
      await act(() => {
        listeners[showEvent]!({ endCoordinates: { height: 320 } });
      });
      expect(result.current).toBe(320);
    });

    it(`resets to 0 on ${hideEvent}`, async () => {
      const { result } = await renderHook(() => useKeyboardHeight());
      await act(() => {
        listeners[showEvent]!({ endCoordinates: { height: 320 } });
      });
      await act(() => {
        listeners[hideEvent]!({});
      });
      expect(result.current).toBe(0);
    });

    it('falls back to 0 when the event has no coordinates', async () => {
      const { result } = await renderHook(() => useKeyboardHeight());
      await act(() => {
        listeners[showEvent]!({});
      });
      expect(result.current).toBe(0);
    });

    it('subscribes to the platform-specific events and removes them on unmount', async () => {
      const removes: jest.Mock[] = [];
      (Keyboard.addListener as jest.Mock).mockImplementation((event: string, cb: Listener) => {
        listeners[event] = cb;
        const remove = jest.fn();
        removes.push(remove);
        return { remove } as unknown as EmitterSubscription;
      });

      const { unmount } = await renderHook(() => useKeyboardHeight());
      expect(Object.keys(listeners).sort()).toEqual([hideEvent, showEvent].sort());

      await unmount();
      expect(removes).toHaveLength(2);
      removes.forEach((remove) => expect(remove).toHaveBeenCalled());
    });
  });
});
