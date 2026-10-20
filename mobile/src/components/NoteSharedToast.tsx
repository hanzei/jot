import { useEffect } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { noteShareNoticeParts } from '@jot/shared';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useSSEContext } from '../store/SSEContext';
import { useUsers } from '../store/UsersContext';
import { useToast } from '../hooks/useToast';

/**
 * Shows a toast with an Open action when a note is shared with the signed-in
 * user while the app is open. useSSE persists the note first and only forwards
 * `note_shared` to listeners when the share targets this user, so Open lands on
 * a note that is already in SQLite and goes through the normal open path (which
 * clears the "New" badge). Renders nothing itself.
 */
export default function NoteSharedToast(): null {
  const { subscribe } = useSSEContext();
  const { showToast } = useToast();
  const { usersById } = useUsers();
  const { t } = useTranslation();
  // Mounted outside the stack navigator, this resolves to the root navigation.
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  useEffect(() => {
    return subscribe((event) => {
      if (event.type !== 'note_shared') return;
      const noteId = event.data.note_id;
      const { name, title } = noteShareNoticeParts(event, usersById);
      showToast(t('dashboard.noteSharedWithYou', {
        name: name || t('dashboard.someone'),
        title: title || t('dashboard.untitledNote'),
      }), 'info', {
        label: t('dashboard.openNote'),
        onPress: () => navigation.navigate('NoteEditor', { noteId }),
      });
    });
  }, [subscribe, showToast, usersById, t, navigation]);

  return null;
}
