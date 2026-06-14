import React, { useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { getAvatarColor } from '@jot/shared';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';
import { useProfileIcon } from '../hooks/useProfileIcon';

const SIZE_MAP = {
  small: 24,
  medium: 36,
  large: 52,
};

interface UserAvatarProps {
  userId?: string;
  username: string;
  hasProfileIcon?: boolean;
  // Cache-invalidation key (typically user.updated_at). When provided, the
  // locally-cached file is tied to this version so stale icons are replaced.
  iconVersion?: string;
  size?: 'small' | 'medium' | 'large';
}

export default function UserAvatar({ userId, username, hasProfileIcon, iconVersion, size = 'medium' }: UserAvatarProps) {
  const [imageError, setImageError] = useState(false);
  const baseUrl = useActiveServerBaseUrl();
  const dimension = SIZE_MAP[size];
  const fontSize = size === 'small' ? 10 : size === 'medium' ? 15 : 22;

  const networkUrl =
    hasProfileIcon && userId ? `${baseUrl}/api/v1/users/${userId}/profile-icon` : '';

  const localUri = useProfileIcon(userId, hasProfileIcon ?? false, iconVersion, networkUrl);

  // Reset the image error state when the avatar identity changes.
  React.useEffect(() => {
    setImageError(false);
  }, [baseUrl, userId, iconVersion]);

  const safeUsername = username || 'U';
  const bgColor = getAvatarColor(safeUsername);
  const letter = safeUsername.charAt(0).toUpperCase();

  // Prefer local cache; fall back to network URL; fall back to initials on error.
  const imageUri = localUri || networkUrl;

  if (hasProfileIcon && userId && imageUri && !imageError) {
    return (
      <Image
        source={{ uri: imageUri }}
        style={[styles.avatar, { width: dimension, height: dimension, borderRadius: dimension / 2 }]}
        accessibilityRole="image"
        accessibilityLabel={`${safeUsername} profile picture`}
        onError={() => setImageError(true)}
      />
    );
  }

  return (
    <View
      style={[
        styles.avatar,
        { width: dimension, height: dimension, borderRadius: dimension / 2, backgroundColor: bgColor },
      ]}
      accessibilityRole="image"
      accessibilityLabel={`${safeUsername} avatar initials`}
    >
      <Text style={[styles.letter, { fontSize }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  letter: {
    color: '#fff',
    fontWeight: '600',
  },
});
