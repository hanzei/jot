import type { Note, User } from '@jot/shared';

export interface AvatarInfo {
  key: string;
  userId?: string;
  username: string;
  firstName?: string;
  displayName: string;
  hasProfileIcon?: boolean;
}

function formatDisplayName(username: string, firstName?: string, lastName?: string): string {
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return fullName || username;
}

export function buildShareAvatars(
  note: Note,
  currentUserId: string | undefined,
  usersById: Map<string, User> | undefined,
): AvatarInfo[] {
  const isOwner = note.user_id === currentUserId;
  const avatars: AvatarInfo[] = [];

  // For non-owners, show the owner
  if (!isOwner) {
    const owner = usersById?.get(note.user_id);
    avatars.push({
      key: 'owner',
      userId: note.user_id,
      username: owner?.username || '?',
      firstName: owner?.first_name,
      displayName: formatDisplayName(owner?.username || '?', owner?.first_name, owner?.last_name),
      hasProfileIcon: owner?.has_profile_icon,
    });
  }

  // Show other shared recipients (excluding current user)
  note.shared_with
    ?.filter(s => s.shared_with_user_id !== currentUserId)
    .forEach(s => {
      const u = usersById?.get(s.shared_with_user_id);
      avatars.push({
        key: s.id,
        userId: s.shared_with_user_id,
        username: s.username || '?',
        firstName: s.first_name,
        displayName: formatDisplayName(s.username || '?', s.first_name, s.last_name),
        hasProfileIcon: s.has_profile_icon ?? u?.has_profile_icon,
      });
    });

  return avatars;
}
