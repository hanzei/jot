import type { User } from './types';

/** How many past collaborators the share pickers offer as one-tap suggestions. */
export const RECENT_SHARE_TARGETS_LIMIT = 5;

export interface Collaborator {
  userId: string;
  username: string;
  firstName?: string;
  lastName?: string;
  hasProfileIcon?: boolean;
  iconVersion?: string;
}

export function displayName(c: Collaborator): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(' ');
  return full || c.username;
}

export function buildCollaborators(
  noteUserId: string,
  sharedWith: { shared_with_user_id: string; username?: string; first_name?: string; last_name?: string; has_profile_icon?: boolean }[] | undefined,
  usersById: Map<string, User> | undefined,
): Collaborator[] {
  const result: Collaborator[] = [];
  const seen = new Set<string>();

  const owner = usersById?.get(noteUserId);
  result.push({
    userId: noteUserId,
    username: owner?.username || '?',
    ...(owner?.first_name !== undefined && { firstName: owner.first_name }),
    ...(owner?.last_name !== undefined && { lastName: owner.last_name }),
    ...(owner?.has_profile_icon !== undefined && { hasProfileIcon: owner.has_profile_icon }),
    ...(owner?.updated_at !== undefined && { iconVersion: owner.updated_at }),
  });
  seen.add(noteUserId);

  sharedWith?.forEach(s => {
    if (seen.has(s.shared_with_user_id)) return;
    seen.add(s.shared_with_user_id);
    const u = usersById?.get(s.shared_with_user_id);
    const firstName = u?.first_name || s.first_name;
    const lastName = u?.last_name || s.last_name;
    const hasProfileIcon = u?.has_profile_icon ?? s.has_profile_icon;
    result.push({
      userId: s.shared_with_user_id,
      username: u?.username || s.username || '?',
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(hasProfileIcon !== undefined && { hasProfileIcon }),
      ...(u?.updated_at !== undefined && { iconVersion: u.updated_at }),
    });
  });

  return result;
}

/**
 * The slice of a note the share history is derived from. Kept structural so
 * both a webapp `Note` and mobile's locally persisted note rows satisfy it
 * without either client converting first.
 */
export interface ShareHistorySource {
  shared_with?: {
    shared_with_user_id: string;
    shared_by_user_id: string;
    created_at: string;
  }[];
}

function toTimestamp(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * User IDs the current user has most recently shared a note with, newest first.
 *
 * Derived entirely from the `shared_with` records already embedded in the notes
 * both clients hold, so there is no dedicated endpoint or history table behind
 * it — which also means it reflects *live* shares: revoking a share (or
 * deleting the note) drops the collaborator from this list. That is the
 * intended reading, "people I currently collaborate with, most recent first".
 *
 * Only shares the current user created count. Notes shared *with* them
 * contribute nothing, which `shared_by_user_id` captures exactly since the
 * server only lets a note's owner share it.
 */
export function recentShareTargets(
  notes: ShareHistorySource[] | undefined,
  currentUserId: string,
  limit: number = RECENT_SHARE_TARGETS_LIMIT,
): string[] {
  if (!notes || !currentUserId || limit <= 0) return [];

  const lastSharedAt = new Map<string, number>();
  notes.forEach(note => {
    note.shared_with?.forEach(share => {
      if (share.shared_by_user_id !== currentUserId) return;
      const at = toTimestamp(share.created_at);
      const previous = lastSharedAt.get(share.shared_with_user_id);
      if (previous === undefined || at > previous) {
        lastSharedAt.set(share.shared_with_user_id, at);
      }
    });
  });

  return Array.from(lastSharedAt.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    // Not `.map(([userId]) => userId)`: array destructuring anywhere in
    // shared/src pulls in a @babel/runtime helper that mobile cannot resolve,
    // and every mobile suite then fails to load. See CLAUDE.md.
    .map(entry => entry[0]);
}

export interface ShareSuggestions {
  /** Past collaborators, most recently shared with first. */
  recent: User[];
  /** Everyone else, alphabetical by display name. */
  others: User[];
}

function suggestionSortName(user: User): string {
  return displayName({
    userId: user.id,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
  }).toLowerCase();
}

/**
 * Splits share candidates into the two groups the share pickers render.
 *
 * `recentUserIds` entries that aren't in `users` are dropped rather than
 * rendered as placeholders — the candidate list is the authority on who can
 * still be shared with.
 *
 * Callers showing a flat, ranked list (while the user is searching) can
 * concatenate `recent` and `others`; callers showing the empty-query state
 * render them as separate labelled sections.
 */
export function buildShareSuggestions(
  users: User[],
  recentUserIds: string[],
  excludedUserIds: Set<string>,
): ShareSuggestions {
  const candidates = new Map<string, User>();
  users.forEach(user => {
    if (!excludedUserIds.has(user.id)) candidates.set(user.id, user);
  });

  const recent: User[] = [];
  recentUserIds.forEach(userId => {
    const user = candidates.get(userId);
    if (!user) return;
    candidates.delete(userId);
    recent.push(user);
  });

  const others = Array.from(candidates.values()).sort((a, b) =>
    suggestionSortName(a).localeCompare(suggestionSortName(b)),
  );

  return { recent, others };
}
