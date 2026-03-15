import { NoteShare } from '../types';

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
  sharedWith: NoteShare[] | undefined,
  ownerUsername?: string,
): Collaborator[] {
  const result: Collaborator[] = [];
  const seen = new Set<string>();

  result.push({
    userId: noteUserId,
    username: ownerUsername || '?',
  });
  seen.add(noteUserId);

  sharedWith?.forEach((s) => {
    if (seen.has(s.shared_with_user_id)) return;
    seen.add(s.shared_with_user_id);
    result.push({
      userId: s.shared_with_user_id,
      username: s.username || '?',
      firstName: s.first_name,
      lastName: s.last_name,
      hasProfileIcon: s.has_profile_icon,
    });
  });

  return result;
}
