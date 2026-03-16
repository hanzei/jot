import { useState } from 'react';
import { AVATAR_COLORS, hashUsername } from '@jot/shared';

interface LetterAvatarProps {
  firstName?: string;
  username: string;
  className?: string;
  userId?: string;
  hasProfileIcon?: boolean;
}

const LetterAvatar = ({ firstName, username, className = '', userId, hasProfileIcon }: LetterAvatarProps) => {
  const [imgFailed, setImgFailed] = useState(false);
  // Reset imgFailed when userId changes using React's "derived state from props"
  // pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  const [prevUserId, setPrevUserId] = useState(userId);
  if (prevUserId !== userId) {
    setPrevUserId(userId);
    setImgFailed(false);
  }
  const accessibleLabel = username || firstName || '?';

  if (hasProfileIcon && userId && !imgFailed) {
    return (
      <img
        src={`/api/v1/users/${userId}/profile-icon`}
        alt={accessibleLabel}
        className={`rounded-full object-cover ${className}`}
        onError={() => setImgFailed(true)}
      />
    );
  }

  const letter = (firstName?.[0] || username[0] || '?').toUpperCase();
  const color = AVATAR_COLORS[hashUsername(username) % AVATAR_COLORS.length];

  return (
    <svg className={`rounded-full ${className}`} viewBox="0 0 40 40" role="img" aria-label={accessibleLabel}>
      <circle cx="20" cy="20" r="20" fill={color} />
      <text x="20" y="20" textAnchor="middle" dy="0.36em" fill="white" fontSize="18" fontWeight="500">
        {letter}
      </text>
    </svg>
  );
};

export default LetterAvatar;
