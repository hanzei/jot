import { useState } from 'react';

const COLORS = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#f59e0b', // amber-500
  '#ca8a04', // yellow-600
  '#65a30d', // lime-600
  '#22c55e', // green-500
  '#10b981', // emerald-500
  '#14b8a6', // teal-500
  '#06b6d4', // cyan-500
  '#0ea5e9', // sky-500
  '#3b82f6', // blue-500
  '#6366f1', // indigo-500
  '#8b5cf6', // violet-500
  '#a855f7', // purple-500
  '#d946ef', // fuchsia-500
  '#ec4899', // pink-500
];

function hashUsername(username: string): number {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

interface LetterAvatarProps {
  firstName?: string;
  username: string;
  className?: string;
  userId?: string;
  hasProfileIcon?: boolean;
}

const LetterAvatar = ({ firstName, username, className = '', userId, hasProfileIcon }: LetterAvatarProps) => {
  const [imgFailed, setImgFailed] = useState(false);
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
  const color = COLORS[hashUsername(username) % COLORS.length];

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
