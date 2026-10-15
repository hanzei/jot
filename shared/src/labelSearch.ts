import type { Label } from './types';

// Shared by the webapp and mobile label pickers so both filter and offer
// "Create …" by the same rules.

/**
 * Labels whose name contains the trimmed query, case-insensitively. A blank
 * query matches every label.
 */
export function filterLabelsByQuery<T extends Pick<Label, 'name'>>(labels: readonly T[], query: string): readonly T[] {
  const q = query.trim().toLowerCase();
  if (!q) return labels;
  return labels.filter(l => l.name.toLowerCase().includes(q));
}

/**
 * Whether the picker should offer to create a label from the query: it is
 * non-blank and no existing label has that exact name, ignoring case (adding
 * "work" when "Work" exists would otherwise make a near-duplicate). An exact
 * match is also a substring match, so callers may pass the labels already
 * narrowed by filterLabelsByQuery for the same query.
 */
export function canCreateLabelFromQuery(labels: readonly Pick<Label, 'name'>[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return !labels.some(l => l.name.toLowerCase() === q);
}
