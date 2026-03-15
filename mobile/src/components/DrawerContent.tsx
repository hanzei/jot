import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Platform } from 'react-native';
import { DrawerContentScrollView, DrawerContentComponentProps } from '@react-navigation/drawer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAuth } from '../store/AuthContext';
import { useLabels } from '../hooks/useLabels';

import type { MainDrawerParamList } from '../navigation/MainDrawer';

interface NavItem {
  name: keyof MainDrawerParamList;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}

const TOP_ITEMS: NavItem[] = [
  { name: 'Notes', label: 'Notes', icon: 'document-text-outline', activeIcon: 'document-text' },
  { name: 'MyTodo', label: 'My Todo', icon: 'clipboard-outline', activeIcon: 'clipboard' },
];

const BOTTOM_ITEMS: NavItem[] = [
  { name: 'Archived', label: 'Archive', icon: 'archive-outline', activeIcon: 'archive' },
  { name: 'Trash', label: 'Trash', icon: 'trash-outline', activeIcon: 'trash' },
];

export default function DrawerContent(props: DrawerContentComponentProps) {
  const { user, logout } = useAuth();
  const { data: labels } = useLabels();
  const insets = useSafeAreaInsets();

  const activeRoute = props.state.routes[props.state.index]?.name;
  const activeParams = props.state.routes[props.state.index]?.params as
    | { labelId?: string } | undefined;
  const activeLabelId = activeRoute === 'Notes' ? activeParams?.labelId : undefined;

  const handleLogout = useCallback(() => {
    Alert.alert('Log out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: () => logout(),
      },
    ]);
  }, [logout]);

  const handleNavPress = useCallback((name: keyof MainDrawerParamList) => {
    if (name === 'Notes') {
      props.navigation.navigate('Notes', { labelId: undefined, labelName: undefined });
    } else {
      props.navigation.navigate(name);
    }
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const handleLabelPress = useCallback((labelId: string, labelName: string) => {
    props.navigation.navigate('Notes', { labelId, labelName });
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const displayName = user
    ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username
    : '';

  const initials = user
    ? (user.first_name?.[0] ?? user.username?.[0] ?? '').toUpperCase()
    : '';

  const isNotesActiveWithoutLabel = activeRoute === 'Notes' && !activeLabelId;

  return (
    <View style={styles.container}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={styles.scrollContent}
      >
        {/* User profile section */}
        <View style={styles.profileSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.displayName} numberOfLines={1}>{displayName}</Text>
          {user && displayName !== user.username && (
            <Text style={styles.username} numberOfLines={1}>@{user.username}</Text>
          )}
        </View>

        <View style={styles.divider} />

        <View style={styles.navSection}>
          {/* Top nav items (Notes, My Todo) */}
          {TOP_ITEMS.map((item) => {
            const isActive = item.name === 'Notes'
              ? isNotesActiveWithoutLabel
              : activeRoute === item.name;
            return (
              <TouchableOpacity
                key={item.name}
                style={[styles.navItem, isActive && styles.navItemActive]}
                onPress={() => handleNavPress(item.name)}
                testID={`drawer-item-${item.name.toLowerCase()}`}
                accessibilityLabel={item.label}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Ionicons
                  name={isActive ? item.activeIcon : item.icon}
                  size={22}
                  color={isActive ? '#2563eb' : '#444'}
                />
                <Text style={[styles.navItemText, isActive && styles.navItemTextActive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}

          {/* Labels */}
          {labels && labels.length > 0 && labels.map((label) => {
            const isActive = activeLabelId === label.id;
            return (
              <TouchableOpacity
                key={label.id}
                style={[styles.navItem, isActive && styles.navItemActive]}
                onPress={() => handleLabelPress(label.id, label.name)}
                testID={`drawer-label-${label.id}`}
                accessibilityLabel={label.name}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Ionicons
                  name={isActive ? 'pricetag' : 'pricetag-outline'}
                  size={22}
                  color={isActive ? '#2563eb' : '#444'}
                />
                <Text
                  style={[styles.navItemText, isActive && styles.navItemTextActive]}
                  numberOfLines={1}
                >
                  {label.name}
                </Text>
              </TouchableOpacity>
            );
          })}

          {/* Archive & Trash */}
          {BOTTOM_ITEMS.map((item) => {
            const isActive = activeRoute === item.name;
            return (
              <TouchableOpacity
                key={item.name}
                style={[styles.navItem, isActive && styles.navItemActive]}
                onPress={() => handleNavPress(item.name)}
                testID={`drawer-item-${item.name.toLowerCase()}`}
                accessibilityLabel={item.label}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Ionicons
                  name={isActive ? item.activeIcon : item.icon}
                  size={22}
                  color={isActive ? '#2563eb' : '#444'}
                />
                <Text style={[styles.navItemText, isActive && styles.navItemTextActive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </DrawerContentScrollView>

      {/* Logout button pinned to bottom */}
      <View style={[styles.bottomSection, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.divider} />
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          testID="drawer-logout"
          accessibilityLabel="Log out"
          accessibilityRole="button"
        >
          <Ionicons name="log-out-outline" size={22} color="#ef4444" />
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollContent: {
    paddingTop: Platform.OS === 'ios' ? 0 : 8,
  },
  profileSection: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#2563eb',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
  },
  displayName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  username: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: '#f3f4f6',
    marginHorizontal: 20,
  },
  navSection: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    gap: 14,
  },
  navItemActive: {
    backgroundColor: '#eff6ff',
  },
  navItemText: {
    fontSize: 15,
    color: '#444',
    fontWeight: '400',
    flexShrink: 1,
  },
  navItemTextActive: {
    color: '#2563eb',
    fontWeight: '600',
  },
  bottomSection: {
    paddingTop: 0,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 14,
  },
  logoutText: {
    fontSize: 15,
    color: '#ef4444',
    fontWeight: '500',
  },
});
