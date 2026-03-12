import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { UserInfo } from '../types';

interface Props {
  user: UserInfo;
  size?: number;
}

export default function UserAvatar({ user, size = 40 }: Props) {
  const initials = [user.first_name, user.last_name]
    .filter(Boolean)
    .map((n) => n[0].toUpperCase())
    .join('') || user.username[0].toUpperCase();

  const backgroundColor = stringToColor(user.username);

  return (
    <View
      style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor }]}
      accessibilityRole="image"
      accessibilityLabel={`Avatar for ${user.username}`}
    >
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{initials}</Text>
    </View>
  );
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 50%, 60%)`;
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontWeight: '600' },
});
