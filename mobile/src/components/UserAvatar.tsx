import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { getAvatarColor } from '@jot/shared';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';

const SIZE_MAP = {
  small: 24,
  medium: 36,
};

interface UserAvatarProps {
  userId: string;
  username: string;
  hasProfileIcon?: boolean;
  size?: 'small' | 'medium';
}

export default function UserAvatar({ userId, username, hasProfileIcon, size = 'medium' }: UserAvatarProps) {
  const [imageError, setImageError] = useState(false);
  const baseUrl = useActiveServerBaseUrl();
  const dimension = SIZE_MAP[size];
  const fontSize = size === 'small' ? 10 : 15;

  useEffect(() => {
    setImageError(false);
  }, [baseUrl, userId, hasProfileIcon]);

  const safeUsername = username || 'U';
  const bgColor = getAvatarColor(safeUsername);
  const letter = safeUsername.charAt(0).toUpperCase();

  if (hasProfileIcon && !imageError) {
    return (
      <Image
        source={{ uri: `${baseUrl}/api/v1/users/${userId}/profile-icon` }}
        style={[styles.avatar, { width: dimension, height: dimension, borderRadius: dimension / 2 }]}
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
