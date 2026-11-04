import { useEffect } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';

// Long enough for a keyboardDidShow that follows straight after a hide (focus
// moving between inputs with different keyboard types) to land first.
const KEYBOARD_REOPEN_GRACE_MS = 50;

/**
 * Blurs the focused text input when the keyboard closes.
 *
 * On Android, the back gesture closes the keyboard but leaves the TextInput
 * focused, so its caret keeps blinking with no keyboard. Tapping elsewhere
 * blurs it, and this brings back-to-close in line with that. Keyboard.dismiss()
 * is no use here: it only acts while the keyboard is visible, and by
 * `keyboardDidHide` it no longer is. iOS blurs on its own, so this is a no-op there.
 *
 * The focused input is global, so mount this once at the app root rather than
 * per screen.
 */
export function useBlurOnKeyboardHide(): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Skip if the keyboard came back: that input was just focused on purpose.
        if (!Keyboard.isVisible()) TextInput.State.currentlyFocusedInput()?.blur();
      }, KEYBOARD_REOPEN_GRACE_MS);
    });
    return () => {
      sub.remove();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
