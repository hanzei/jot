import { useState } from 'react';
import { AVATAR_COLORS, hashUsername } from '@jot/shared';

interface LetterAvatarProps {
  firstName?: string;
  username: string;
  className?: string;
  userId?: string;
  hasProfileIcon?: boolean;
  iconVersion?: string;
}

const LetterAvatar = ({ firstName, username, className = '', userId, hasProfileIcon, iconVersion }: LetterAvatarProps) => {
  const [imgFailed, setImgFailed] = useState(false);
  // Reset imgFailed when userId or iconVersion changes using React's "derived state from props"
  // pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  const [prevKey, setPrevKey] = useState(`${userId}:${iconVersion}`);
  const key = `${userId}:${iconVersion}`;
  if (prevKey !== key) {
    setPrevKey(key);
    setImgFailed(false);
  }
  const accessibleLabel = username || firstName || '?';

  if (hasProfileIcon && userId && !imgFailed) {
    const src = iconVersion
      ? `/api/v1/users/${userId}/profile-icon?v=${encodeURIComponent(iconVersion)}`
      : `/api/v1/users/${userId}/profile-icon`;
    return (
      <img
        src={src}
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
