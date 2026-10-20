import { useEffect, useRef } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { displayName, noteNoticeTitle } from '@jot/shared';
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

  // Read through refs so a users refresh or language change doesn't resubscribe.
  const usersByIdRef = useRef(usersById);
  const tRef = useRef(t);
  useEffect(() => {
    usersByIdRef.current = usersById;
    tRef.current = t;
  }, [usersById, t]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type !== 'note_shared') return;
      const tr = tRef.current;
      const noteId = event.data.note_id;
      const sharer = usersByIdRef.current.get(event.source_user_id);
      const name = sharer
        ? displayName({ userId: sharer.id, username: sharer.username, firstName: sharer.first_name, lastName: sharer.last_name })
        : tr('dashboard.someone');
      const title = (event.data.note ? noteNoticeTitle(event.data.note) : '') || tr('dashboard.untitledNote');
      showToast(tr('dashboard.noteSharedWithYou', { name, title }), 'info', {
        label: tr('dashboard.openNote'),
        onPress: () => navigation.navigate('NoteEditor', { noteId }),
      });
    });
  }, [subscribe, showToast, navigation]);

  return null;
}
