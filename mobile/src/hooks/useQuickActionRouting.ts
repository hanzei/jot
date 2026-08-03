import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as QuickActions from 'expo-quick-actions';
import type { NavigationContainerRef } from '@react-navigation/native';
import { generateId } from '@jot/shared';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { buildQuickActionItems, noteTypeForQuickAction } from '../utils/quickActions';
import { setPendingQuickAction, usePendingQuickAction } from '../store/quickAction';

interface UseQuickActionRoutingParams {
  navigationRef: NavigationContainerRef<RootStackParamList>;
  isNavReady: boolean;
  isAuthenticated: boolean;
}

// useQuickActionRouting wires app-icon quick actions ("long-press the launcher
// icon → New note / New list") into the note editor. It registers the localized
// action items with the OS, then stashes an incoming action in a module-level
// store and replays it once the user is authenticated and the navigation tree
// is ready. Quick actions always target the currently active server, so — unlike
// share intents — no server switch is involved; the editor creates an offline
// draft, which works with no network.
export function useQuickActionRouting({
  navigationRef,
  isNavReady,
  isAuthenticated,
}: UseQuickActionRoutingParams): void {
  const { t, i18n } = useTranslation();
  const pending = usePendingQuickAction();

  // Register (and re-register on language change) the quick-action items shown
  // when the user long-presses the app icon. setItems rejects on platforms/
  // devices without quick-action support, so swallow failures.
  useEffect(() => {
    void QuickActions.setItems(buildQuickActionItems(t)).catch(() => {
      // Quick actions are a progressive enhancement; ignore unsupported hosts.
    });
    // i18n.language is the reactive dependency; t is stable per language.
  }, [t, i18n.language]);

  // Capture the action that either launched the app (initial) or arrived while
  // it was running, into the module-level store so it survives the navigation
  // remount a login can trigger.
  useEffect(() => {
    const initialType = noteTypeForQuickAction(QuickActions.initial);
    if (initialType) {
      setPendingQuickAction({ noteType: initialType });
    }
    const subscription = QuickActions.addListener((action) => {
      const noteType = noteTypeForQuickAction(action);
      if (noteType) {
        setPendingQuickAction({ noteType });
      }
    });
    return () => subscription.remove();
  }, []);

  // Replay a pending quick action: open the editor on a fresh note of the
  // requested type once authenticated and the nav tree is ready. Before login
  // it waits; the effect re-runs when isAuthenticated flips.
  //
  // openKey is a freshly generated id, not the quick action's own id: this
  // effect can fire while some other note's editor is still the focused screen
  // (the app was backgrounded mid-edit, then relaunched via the quick action),
  // and without a unique id here React Navigation would navigate back into
  // that stale instance instead of opening a new note (see getNoteScreenId).
  useEffect(() => {
    if (!pending || !isNavReady || !navigationRef.isReady()) {
      return;
    }
    if (!isAuthenticated) {
      // Wait for login; the action is replayed when isAuthenticated flips.
      return;
    }
    navigationRef.navigate('NoteEditor', { noteId: null, initialNoteType: pending.noteType, openKey: generateId() });
    setPendingQuickAction(null);
  }, [pending, isAuthenticated, isNavReady, navigationRef]);
}
