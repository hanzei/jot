import { useEffect } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';

/**
 * Blurs the focused text input when the keyboard closes.
 *
 * On Android, the back gesture closes the keyboard but leaves the TextInput
 * focused, so its caret keeps blinking with no keyboard. Tapping elsewhere
 * blurs it, and this brings back-to-close in line with that. Keyboard.dismiss()
 * is no use here: it only acts while the keyboard is visible, and by
 * `keyboardDidHide` it no longer is. iOS blurs on its own, so this is a no-op there.
 */
export function useBlurOnKeyboardHide(): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      TextInput.State.currentlyFocusedInput()?.blur();
    });
    return () => sub.remove();
  }, []);
}
