import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  Modal,
  Pressable,
  TextInput,
} from 'react-native';
import { DrawerContentScrollView, DrawerContentComponentProps } from '@react-navigation/drawer';
import { CommonActions } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAuth } from '../store/AuthContext';
import { useDeleteLabel, useLabels, useRenameLabel } from '../hooks/useLabels';
import { useTheme } from '../theme/ThemeContext';

import type { Label } from '@jot/shared';
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
  const renameLabel = useRenameLabel();
  const deleteLabel = useDeleteLabel();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [renameLabelTarget, setRenameLabelTarget] = useState<Label | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const longPressHandledRef = useRef(false);

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
    if (longPressHandledRef.current) {
      longPressHandledRef.current = false;
      return;
    }
    props.navigation.navigate('Notes', { labelId, labelName });
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const extractErrorMessage = useCallback((error: unknown, fallback: string) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'data' in error.response &&
      typeof error.response.data === 'string'
    ) {
      const message = error.response.data.trim();
      if (message) {
        return message;
      }
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return fallback;
  }, []);

  const handleLabelRenameSuccess = useCallback((labelId: string, labelName: string) => {
    if (activeLabelId === labelId) {
      props.navigation.navigate('Notes', { labelId, labelName });
    }
  }, [activeLabelId, props.navigation]);

  const handleDeleteLabelSuccess = useCallback((labelId: string) => {
    if (activeLabelId === labelId) {
      props.navigation.navigate('Notes', { labelId: undefined, labelName: undefined });
      props.navigation.closeDrawer();
    }
  }, [activeLabelId, props.navigation]);

  const handleSubmitRename = useCallback(async () => {
    const label = renameLabelTarget;
    const name = renameValue.trim();
    if (!label || !name || renameLabel.isPending) {
      return;
    }

    try {
      const updatedLabel = await renameLabel.mutateAsync({ labelId: label.id, name });
      setRenameLabelTarget(null);
      setRenameValue('');
      handleLabelRenameSuccess(updatedLabel.id, updatedLabel.name);
      Alert.alert('Success', 'Label renamed');
    } catch (error) {
      Alert.alert('Error', extractErrorMessage(error, 'Failed to rename label'));
    }
  }, [extractErrorMessage, handleLabelRenameSuccess, renameLabel, renameLabelTarget, renameValue]);

  const openRenameModal = useCallback((label: Label) => {
    setRenameLabelTarget(label);
    setRenameValue(label.name);
  }, []);

  const handleDeleteLabel = useCallback((label: Label) => {
    Alert.alert(
      'Delete label',
      `Delete label "${label.name}"? It will be removed from all notes that use it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteLabel.mutateAsync({ labelId: label.id });
              handleDeleteLabelSuccess(label.id);
              Alert.alert('Success', 'Label deleted');
            } catch (error) {
              Alert.alert('Error', extractErrorMessage(error, 'Failed to delete label'));
            }
          },
        },
      ],
    );
  }, [deleteLabel, extractErrorMessage, handleDeleteLabelSuccess]);

  const handleLabelLongPress = useCallback((label: Label) => {
    longPressHandledRef.current = true;
    Alert.alert(label.name, 'Choose an action for this label.', [
      { text: 'Rename', onPress: () => openRenameModal(label) },
      { text: 'Delete', style: 'destructive', onPress: () => handleDeleteLabel(label) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [handleDeleteLabel, openRenameModal]);

  const handleSettingsPress = useCallback(() => {
    props.navigation.dispatch(
      CommonActions.navigate({ name: 'Settings' }),
    );
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
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={styles.scrollContent}
      >
        {/* User profile section */}
        <View style={styles.profileSection}>
          <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={[styles.displayName, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
          {user && displayName !== user.username && (
            <Text style={[styles.username, { color: colors.textSecondary }]} numberOfLines={1}>@{user.username}</Text>
          )}
        </View>

        <View style={[styles.divider, { backgroundColor: colors.divider }]} />

        <View style={styles.navSection}>
          {TOP_ITEMS.map((item) => {
            const isActive = item.name === 'Notes'
              ? isNotesActiveWithoutLabel
              : activeRoute === item.name;
            return (
              <TouchableOpacity
                key={item.name}
                style={[styles.navItem, isActive && { backgroundColor: colors.primaryLight }]}
                onPress={() => handleNavPress(item.name)}
                testID={`drawer-item-${item.name.toLowerCase()}`}
                accessibilityLabel={item.label}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Ionicons
                  name={isActive ? item.activeIcon : item.icon}
                  size={22}
                  color={isActive ? colors.primary : colors.icon}
                />
                <Text style={[styles.navItemText, { color: colors.icon }, isActive && { color: colors.primary, fontWeight: '600' }]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}

          {labels && labels.length > 0 && (
            <>
              <View style={[styles.navDivider, { backgroundColor: colors.divider }]} />
              {labels.map((label) => {
                const isActive = activeLabelId === label.id;
                return (
                  <TouchableOpacity
                    key={label.id}
                    style={[styles.navItem, isActive && { backgroundColor: colors.primaryLight }]}
                    onPress={() => handleLabelPress(label.id, label.name)}
                    onLongPress={() => handleLabelLongPress(label)}
                    delayLongPress={250}
                    testID={`drawer-label-${label.id}`}
                    accessibilityLabel={label.name}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                  >
                    <Ionicons
                      name={isActive ? 'pricetag' : 'pricetag-outline'}
                      size={22}
                      color={isActive ? colors.primary : colors.icon}
                    />
                    <Text
                      style={[styles.navItemText, { color: colors.icon }, isActive && { color: colors.primary, fontWeight: '600' }]}
                      numberOfLines={1}
                    >
                      {label.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </>
          )}

          <View style={[styles.navDivider, { backgroundColor: colors.divider }]} />

          {BOTTOM_ITEMS.map((item) => {
            const isActive = activeRoute === item.name;
            return (
              <TouchableOpacity
                key={item.name}
                style={[styles.navItem, isActive && { backgroundColor: colors.primaryLight }]}
                onPress={() => handleNavPress(item.name)}
                testID={`drawer-item-${item.name.toLowerCase()}`}
                accessibilityLabel={item.label}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Ionicons
                  name={isActive ? item.activeIcon : item.icon}
                  size={22}
                  color={isActive ? colors.primary : colors.icon}
                />
                <Text style={[styles.navItemText, { color: colors.icon }, isActive && { color: colors.primary, fontWeight: '600' }]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </DrawerContentScrollView>

      {/* Settings & Logout pinned to bottom */}
      <View style={[styles.bottomSection, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={[styles.divider, { backgroundColor: colors.divider }]} />
        <TouchableOpacity
          style={styles.settingsButton}
          onPress={handleSettingsPress}
          testID="drawer-settings"
          accessibilityLabel="Settings"
          accessibilityRole="button"
        >
          <Ionicons name="settings-outline" size={22} color={colors.icon} />
          <Text style={[styles.settingsText, { color: colors.icon }]}>Settings</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          testID="drawer-logout"
          accessibilityLabel="Log out"
          accessibilityRole="button"
        >
          <Ionicons name="log-out-outline" size={22} color={colors.error} />
          <Text style={[styles.logoutText, { color: colors.error }]}>Log out</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={renameLabelTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!renameLabel.isPending) {
            setRenameLabelTarget(null);
          }
        }}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => {
            if (!renameLabel.isPending) {
              setRenameLabelTarget(null);
            }
          }}
        >
          <Pressable
            style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={(event) => event.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>Rename label</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="Label name"
              placeholderTextColor={colors.placeholder}
              autoFocus
              editable={!renameLabel.isPending}
              returnKeyType="done"
              onSubmitEditing={() => {
                void handleSubmitRename();
              }}
              testID="rename-label-input"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
                onPress={() => {
                  if (!renameLabel.isPending) {
                    setRenameLabelTarget(null);
                  }
                }}
                disabled={renameLabel.isPending}
              >
                <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.modalPrimaryButton,
                  { backgroundColor: colors.primary },
                  !renameValue.trim() && styles.modalButtonDisabled,
                ]}
                onPress={() => {
                  void handleSubmitRename();
                }}
                disabled={!renameValue.trim() || renameLabel.isPending}
                testID="rename-label-submit"
              >
                <Text style={styles.modalPrimaryText}>
                  {renameLabel.isPending ? 'Saving...' : 'Save'}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: Platform.OS === 'ios' ? 0 : 8,
  },
  profileSection: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '600',
  },
  displayName: {
    fontSize: 16,
    fontWeight: '600',
  },
  username: {
    fontSize: 13,
    marginTop: 2,
  },
  divider: {
    height: 1,
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
  navItemText: {
    fontSize: 15,
    fontWeight: '400',
    flexShrink: 1,
  },
  navDivider: {
    height: 1,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  bottomSection: {
    paddingTop: 0,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 16,
  },
  modalButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalPrimaryButton: {},
  modalSecondaryButton: {
    borderWidth: 1,
  },
  modalButtonDisabled: {
    opacity: 0.5,
  },
  modalPrimaryText: {
    color: '#fff',
    fontWeight: '600',
  },
  modalSecondaryText: {
    fontWeight: '500',
  },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 14,
  },
  settingsText: {
    fontSize: 15,
    fontWeight: '500',
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
    fontWeight: '500',
  },
});
