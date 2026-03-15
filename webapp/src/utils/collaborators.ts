import { User } from '@/types';

export interface Collaborator {
  userId: string;
  username: string;
  firstName?: string;
  lastName?: string;
  hasProfileIcon?: boolean;
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
    firstName: owner?.first_name,
    lastName: owner?.last_name,
    hasProfileIcon: owner?.has_profile_icon,
  });
  seen.add(noteUserId);

  sharedWith?.forEach(s => {
    if (seen.has(s.shared_with_user_id)) return;
    seen.add(s.shared_with_user_id);
    const u = usersById?.get(s.shared_with_user_id);
    result.push({
      userId: s.shared_with_user_id,
      username: u?.username || s.username || '?',
      firstName: u?.first_name || s.first_name,
      lastName: u?.last_name || s.last_name,
      hasProfileIcon: u?.has_profile_icon ?? s.has_profile_icon,
    });
  });

  return result;
}
