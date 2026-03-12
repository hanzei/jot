import { Note, User } from '@/types';

export interface AvatarInfo {
  key: string;
  userId?: string;
  username: string;
  firstName?: string;
  hasProfileIcon?: boolean;
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
    if (owner) {
      avatars.push({ key: 'owner', userId: owner.id, username: owner.username, firstName: owner.first_name, hasProfileIcon: owner.has_profile_icon });
    }
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
        hasProfileIcon: s.has_profile_icon ?? u?.has_profile_icon,
      });
    });

  return avatars;
}
