import { Alert } from 'react-native';
import type { TFunction } from 'i18next';
import { isInsecureServerOrigin } from '@jot/shared';

/**
 * Asks the user to confirm adding a server reached over plain HTTP (#1337),
 * resolving `true` at once for any other origin. The deep-link prompt for an
 * unknown server already asks before adding one, so it folds the same message
 * into that prompt instead.
 *
 * A native alert rather than `useConfirm`: the server picker adds servers from
 * inside its own `Modal`, and a second RN `Modal` cannot be presented over it on
 * iOS.
 */
export function confirmInsecureServer(t: TFunction, origin: string): Promise<boolean> {
  if (!isInsecureServerOrigin(origin)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    Alert.alert(
      t('serverSecurity.insecureTitle'),
      t('serverSecurity.insecureMessage', { server: origin }),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('serverSecurity.insecureConfirm'), style: 'destructive', onPress: () => resolve(true) },
      ],
      // Android: a tap outside the dialog or the back button cancels.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
