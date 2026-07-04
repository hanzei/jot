import type { NoteType } from '@jot/shared';
import type { Action } from 'expo-quick-actions';

// Stable IDs for the app-icon quick actions ("long-press the launcher icon").
// They double as the payload we read back when an action launches the app, so
// they must stay in sync with noteTypeForQuickAction below.
export const QUICK_ACTION_NEW_NOTE = 'new_note';
export const QUICK_ACTION_NEW_LIST = 'new_list';

// Minimal translate signature so this module stays pure and unit-testable
// without pulling in the i18next runtime.
type TranslateFn = (key: string) => string;

// buildQuickActionItems returns the localized quick-action items to register
// with the OS. Icons use platform-native identifiers: iOS resolves the
// `symbol:` prefix to an SF Symbol, Android maps the built-in name to a
// launcher-shortcut icon. Registering them dynamically (rather than statically
// in app.json) lets the labels follow the user's chosen app language.
export function buildQuickActionItems(t: TranslateFn): Action[] {
  return [
    {
      id: QUICK_ACTION_NEW_NOTE,
      title: t('quickActions.newNote'),
      icon: 'symbol:square.and.pencil',
      params: { noteType: 'text' },
    },
    {
      id: QUICK_ACTION_NEW_LIST,
      title: t('quickActions.newList'),
      icon: 'symbol:checklist',
      params: { noteType: 'list' },
    },
  ];
}

// noteTypeForQuickAction maps an incoming quick action to the note type the
// editor should open with, or null when the action is not one of ours. It reads
// the action id (authoritative) and falls back to the params payload, so a
// launcher that only round-trips params still resolves correctly.
export function noteTypeForQuickAction(action: { id?: string; params?: Record<string, unknown> | null } | null | undefined): NoteType | null {
  if (!action) {
    return null;
  }
  if (action.id === QUICK_ACTION_NEW_NOTE) {
    return 'text';
  }
  if (action.id === QUICK_ACTION_NEW_LIST) {
    return 'list';
  }
  const paramType = action.params?.noteType;
  if (paramType === 'text' || paramType === 'list') {
    return paramType;
  }
  return null;
}
