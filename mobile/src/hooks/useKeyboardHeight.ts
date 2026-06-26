import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

/**
 * Tracks the height of the on-screen keyboard, returning 0 while it is hidden.
 *
 * This is primarily needed on Android: the app runs edge-to-edge (the default
 * since the new architecture), so the system no longer resizes the window when
 * the keyboard opens. Without manual handling, content drawn near the bottom of
 * the screen (e.g. the last items of a long list) ends up hidden behind the
 * keyboard. Screens use this height to reserve space for the keyboard so that
 * content stays reachable.
 */
export function useKeyboardHeight(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    // iOS exposes the smoother will* events; Android only fires did*.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = (event: KeyboardEvent) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    };
    const onHide = () => setKeyboardHeight(0);

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return keyboardHeight;
}
