import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Note } from '@jot/shared';
import type { RootStackParamList } from '../../navigation/RootNavigator';

export type EditorRouteProp = RouteProp<RootStackParamList, 'NoteEditor'>;
export type EditorNavProp = NativeStackNavigationProp<RootStackParamList, 'NoteEditor'>;

/**
 * The note as the offline cache hands it back — `useOfflineNote(noteId).data`,
 * which is undefined until the query settles and null for a note that isn't in
 * the local database.
 */
export type CachedNote = Note | null | undefined;
