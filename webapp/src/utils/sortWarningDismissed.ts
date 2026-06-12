import type { NoteSort } from '@jot/shared';

const SORT_WARNING_DISMISSED_KEY = 'jot_sort_warning_dismissed';

export function isSortWarningDismissed(sort: NoteSort): boolean {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SORT_WARNING_DISMISSED_KEY) ?? '[]');
    return Array.isArray(raw) && raw.includes(sort);
  } catch {
    return false;
  }
}

export function dismissSortWarning(sort: NoteSort): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SORT_WARNING_DISMISSED_KEY) ?? '[]');
    const list: string[] = Array.isArray(raw) ? raw : [];
    if (!list.includes(sort)) {
      localStorage.setItem(SORT_WARNING_DISMISSED_KEY, JSON.stringify([...list, sort]));
    }
  } catch {
    localStorage.setItem(SORT_WARNING_DISMISSED_KEY, JSON.stringify([sort]));
  }
}
