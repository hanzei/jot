import { Alert } from 'react-native';

/**
 * Answers the plain-HTTP warning (`confirmInsecureServer`) by pressing its
 * Cancel or "Connect anyway" button, and returns the Alert spy.
 */
export function answerInsecureWarning(button: 'confirm' | 'cancel'): jest.SpyInstance {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.[button === 'confirm' ? 1 : 0]?.onPress?.();
  });
}
