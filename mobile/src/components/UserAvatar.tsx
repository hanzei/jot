import React, { useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { BASE_URL } from '../api/client';

const AVATAR_COLORS = [
  '#f28b82',
  '#fbbc04',
  '#ccff90',
  '#a7ffeb',
  '#cbf0f8',
  '#aecbfa',
  '#d7aefb',
  '#fdcfe8',
];

function getUserColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

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
  const dimension = SIZE_MAP[size];
  const fontSize = size === 'small' ? 10 : 15;

  const bgColor = getUserColor(username);
  const letter = username.charAt(0).toUpperCase();

  if (hasProfileIcon && !imageError) {
    return (
      <Image
        source={{ uri: `${BASE_URL}/api/v1/users/${userId}/profile-icon` }}
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
    color: '#1a1a1a',
    fontWeight: '600',
  },
});
