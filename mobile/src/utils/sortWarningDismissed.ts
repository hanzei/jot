import * as SecureStore from 'expo-secure-store';
import type { NoteSort } from '@jot/shared';

const SORT_WARNING_DISMISSED_KEY = 'jot_sort_warning_dismissed';

export async function isSortWarningDismissed(sort: NoteSort): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse((await SecureStore.getItemAsync(SORT_WARNING_DISMISSED_KEY)) ?? '[]');
    return Array.isArray(raw) && raw.includes(sort);
  } catch {
    return false;
  }
}

export async function dismissSortWarning(sort: NoteSort): Promise<void> {
  try {
    const raw: unknown = JSON.parse((await SecureStore.getItemAsync(SORT_WARNING_DISMISSED_KEY)) ?? '[]');
    const list: string[] = Array.isArray(raw) ? raw : [];
    if (!list.includes(sort)) {
      await SecureStore.setItemAsync(SORT_WARNING_DISMISSED_KEY, JSON.stringify([...list, sort]));
    }
  } catch {
    // Storage failure — skip persistence; in-session dismissed state is already set by the caller.
  }
}
