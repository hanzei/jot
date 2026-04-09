import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Modal,
  Pressable,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { DrawerContentScrollView, DrawerContentComponentProps } from '@react-navigation/drawer';
import { CommonActions } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/AuthContext';
import { useCreateLabel, useDeleteLabel, useLabelCounts, useLabels, useRenameLabel } from '../hooks/useLabels';
import { useTheme } from '../theme/ThemeContext';
import { getActiveServer, listServers, type ServerAccountEntry } from '../store/serverAccounts';
import { switchActiveServer } from '../api/client';
import UserAvatar from './UserAvatar';
import ServerSetupGate from './ServerSetupGate';

import type { Label } from '@jot/shared';
import type { MainDrawerParamList } from '../navigation/MainDrawer';

interface NavItem {
  name: keyof MainDrawerParamList;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}

function extractErrorMessage(error: unknown, fallback: string) {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const { data } = response as { data?: unknown };
      if (typeof data === 'string') {
        const message = data.trim();
        if (message) {
          return message;
        }
      } else if (typeof data === 'object' && data !== null) {
        const objectData = data as { message?: unknown; error?: unknown; detail?: unknown };
        for (const candidate of [objectData.message, objectData.error, objectData.detail]) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
      }
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export default function DrawerContent(props: DrawerContentComponentProps) {
  const { user, logout, revalidateSession } = useAuth();
  const { data: labels } = useLabels();
  const { data: labelCounts } = useLabelCounts();
  const createLabel = useCreateLabel();
  const renameLabel = useRenameLabel();
  const deleteLabel = useDeleteLabel();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const topItems: NavItem[] = [
    { name: 'Notes', label: t('dashboard.tabNotes'), icon: 'document-text-outline', activeIcon: 'document-text' },
    { name: 'MyTasks', label: t('dashboard.tabMyTasks'), icon: 'clipboard-outline', activeIcon: 'clipboard' },
  ];
  const bottomItems: NavItem[] = [
    { name: 'Archived', label: t('dashboard.tabArchive'), icon: 'archive-outline', activeIcon: 'archive' },
    { name: 'Trash', label: t('dashboard.tabBin'), icon: 'trash-outline', activeIcon: 'trash' },
  ];
  const [renameLabelTarget, setRenameLabelTarget] = useState<Label | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isCreateLabelVisible, setIsCreateLabelVisible] = useState(false);
  const [newLabelValue, setNewLabelValue] = useState('');
  const [isServerPickerVisible, setIsServerPickerVisible] = useState(false);
  const [isServerSetupVisible, setIsServerSetupVisible] = useState(false);
  const [servers, setServers] = useState<ServerAccountEntry[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [isServerActionPending, setIsServerActionPending] = useState(false);
  const serverSwitchingRef = useRef(false);
  const longPressHandledRef = useRef(false);

  const activeRoute = props.state.routes[props.state.index]?.name;
  const activeParams = props.state.routes[props.state.index]?.params as
    | { labelId?: string } | undefined;
  const activeLabelId = activeRoute === 'Notes' ? activeParams?.labelId : undefined;

  const handleLogout = useCallback(() => {
    Alert.alert(t('nav.logoutConfirmTitle'), t('nav.logoutConfirmMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('nav.logout'),
        style: 'destructive',
        onPress: () => logout(),
      },
    ]);
  }, [logout, t]);

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
      Alert.alert(t('labels.renameSuccess'));
    } catch (error) {
      Alert.alert(t('common.error'), extractErrorMessage(error, t('labels.renameError')));
    }
  }, [handleLabelRenameSuccess, renameLabel, renameLabelTarget, renameValue, t]);

  const openRenameModal = useCallback((label: Label) => {
    setRenameLabelTarget(label);
    setRenameValue(label.name);
  }, []);

  const handleDeleteLabel = useCallback((label: Label) => {
    Alert.alert(
      t('labels.deleteConfirmTitle'),
      t('labels.deleteConfirmMessage', { name: label.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('labels.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteLabel.mutateAsync({ labelId: label.id });
              handleDeleteLabelSuccess(label.id);
              Alert.alert(t('labels.deleteSuccess'));
            } catch (error) {
              Alert.alert(t('common.error'), extractErrorMessage(error, t('labels.deleteError')));
            }
          },
        },
      ],
    );
  }, [deleteLabel, handleDeleteLabelSuccess, t]);

  const handleSubmitCreateLabel = useCallback(async () => {
    const name = newLabelValue.trim();
    if (!name || createLabel.isPending) {
      return;
    }

    try {
      await createLabel.mutateAsync({ name });
      setIsCreateLabelVisible(false);
      setNewLabelValue('');
      Alert.alert(t('labels.createSuccess'));
    } catch (error) {
      Alert.alert(t('common.error'), extractErrorMessage(error, t('labels.createError')));
    }
  }, [createLabel, newLabelValue, t]);

  const closeCreateLabelModal = useCallback(() => {
    if (createLabel.isPending) {
      return;
    }
    setIsCreateLabelVisible(false);
    setNewLabelValue('');
  }, [createLabel.isPending]);

  const resetLongPressHandled = useCallback(() => {
    longPressHandledRef.current = false;
  }, []);

  const openLabelMenu = useCallback((label: Label) => {
    Alert.alert(label.name, t('labels.menuOptions', { name: label.name }), [
      {
        text: t('labels.rename'),
        onPress: () => {
          resetLongPressHandled();
          openRenameModal(label);
        },
      },
      {
        text: t('labels.delete'),
        style: 'destructive',
        onPress: () => {
          resetLongPressHandled();
          handleDeleteLabel(label);
        },
      },
      { text: t('common.cancel'), style: 'cancel', onPress: resetLongPressHandled },
    ], { cancelable: true, onDismiss: resetLongPressHandled });
  }, [handleDeleteLabel, openRenameModal, resetLongPressHandled, t]);

  const handleLabelLongPress = useCallback((label: Label) => {
    longPressHandledRef.current = true;
    openLabelMenu(label);
  }, [openLabelMenu]);

  const handleSettingsPress = useCallback(() => {
    props.navigation.dispatch(
      CommonActions.navigate({ name: 'Settings' }),
    );
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const loadServerPickerData = useCallback(async () => {
    const [serverList, activeServer] = await Promise.all([listServers(), getActiveServer()]);
    setServers(serverList);
    setActiveServerId(activeServer?.serverId ?? null);
  }, []);

  const refreshServerPickerData = useCallback(async () => {
    try {
      await loadServerPickerData();
      return true;
    } catch (error) {
      console.warn('Failed to load server picker data:', error);
      Alert.alert(t('common.error'), t('serverPicker.switchFailed'));
      return false;
    }
  }, [loadServerPickerData, t]);

  const handleOpenServerPicker = useCallback(() => {
    setIsServerPickerVisible(true);
    void refreshServerPickerData();
  }, [refreshServerPickerData]);

  const handleSwitchToServer = useCallback(async (serverId: string) => {
    if (isServerActionPending || serverSwitchingRef.current) {
      return;
    }
    serverSwitchingRef.current = true;
    setIsServerActionPending(true);
    let switchedSuccessfully = false;
    try {
      const switched = await switchActiveServer(serverId);
      if (!switched) {
        Alert.alert(t('common.error'), t('serverPicker.switchFailed'));
        return;
      }
      switchedSuccessfully = true;
      await revalidateSession();
      setIsServerPickerVisible(false);
      props.navigation.closeDrawer();
    } catch {
      Alert.alert(t('common.error'), t('serverPicker.switchFailed'));
    } finally {
      setIsServerActionPending(false);
      serverSwitchingRef.current = false;
      if (switchedSuccessfully) {
        try {
          await loadServerPickerData();
        } catch (error) {
          console.warn('Failed to refresh server picker data after successful switch:', error);
        }
      } else {
        await refreshServerPickerData();
      }
    }
  }, [isServerActionPending, loadServerPickerData, props.navigation, revalidateSession, refreshServerPickerData, t]);

  const handleOpenServerSetup = useCallback(() => {
    if (isServerActionPending) {
      return;
    }
    setIsServerPickerVisible(false);
    setIsServerSetupVisible(true);
  }, [isServerActionPending]);

  const handleBackToDashboardFromServerSetup = useCallback(() => {
    setIsServerSetupVisible(false);
    setIsServerPickerVisible(false);
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const displayName = user
    ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username
    : '';

  const isNotesActiveWithoutLabel = activeRoute === 'Notes' && !activeLabelId;

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={{ paddingTop: insets.top + 8 }}
      >
        {/* User profile section */}
        <TouchableOpacity
          style={styles.profileSection}
          onPress={handleOpenServerPicker}
          accessibilityRole="button"
          accessibilityLabel={t('serverPicker.open')}
          testID="drawer-profile-button"
        >
          <UserAvatar
            userId={user?.id ?? ''}
            username={user?.username ?? ''}
            hasProfileIcon={user?.has_profile_icon}
            size="large"
          />
          <View style={styles.profileTextWrap}>
            <Text style={[styles.displayName, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
            {user && displayName !== user.username && (
              <Text style={[styles.username, { color: colors.textSecondary }]} numberOfLines={1}>@{user.username}</Text>
            )}
            <Text style={[styles.serverPickerHint, { color: colors.textSecondary }]} numberOfLines={1}>
              {t('serverPicker.open')}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </TouchableOpacity>

        <View style={[styles.divider, { backgroundColor: colors.divider }]} />

        <View style={styles.navSection}>
          {topItems.map((item) => {
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
                const labelCount = labelCounts?.[label.id] ?? 0;
                const labelAccessibilityName = `${label.name}, ${labelCount}`;
                return (
                  <View
                    key={label.id}
                    style={[styles.labelRow, isActive && { backgroundColor: colors.primaryLight }]}
                  >
                    <TouchableOpacity
                      style={[styles.navItem, styles.labelNavItem]}
                      onPress={() => handleLabelPress(label.id, label.name)}
                      onLongPress={() => handleLabelLongPress(label)}
                      delayLongPress={250}
                      testID={`drawer-label-${label.id}`}
                      accessibilityLabel={labelAccessibilityName}
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
                    <Text
                      style={[styles.labelCount, { color: isActive ? colors.primary : colors.textSecondary }]}
                      testID={`drawer-label-count-${label.id}`}
                    >
                      {labelCount}
                    </Text>
                    <TouchableOpacity
                      style={styles.labelMenuButton}
                      onPress={() => openLabelMenu(label)}
                      hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`${label.name}. ${t('labels.menuOptions', { name: label.name })}`}
                      testID={`drawer-label-menu-${label.id}`}
                    >
                      <Ionicons
                        name="ellipsis-vertical"
                        size={18}
                        color={isActive ? colors.primary : colors.icon}
                      />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </>
          )}

          <TouchableOpacity
            style={styles.navItem}
            onPress={() => {
              setRenameLabelTarget(null);
              setNewLabelValue('');
              setIsCreateLabelVisible(true);
            }}
            testID="drawer-label-create"
            accessibilityRole="button"
            accessibilityLabel={t('labels.newSidebar')}
          >
            <Ionicons name="add" size={22} color={colors.primary} />
            <Text style={[styles.navItemText, { color: colors.primary, fontWeight: '600' }]}>
              {t('labels.newSidebar')}
            </Text>
          </TouchableOpacity>

          <View style={[styles.navDivider, { backgroundColor: colors.divider }]} />

          {bottomItems.map((item) => {
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
      <View
        style={[styles.bottomSection, { paddingBottom: Math.max(insets.bottom, 16) }]}
        testID="drawer-bottom-section"
      >
        <View style={[styles.divider, { backgroundColor: colors.divider }]} />
        <TouchableOpacity
          style={styles.settingsButton}
          onPress={handleSettingsPress}
          testID="drawer-settings"
          accessibilityLabel={t('nav.settings')}
          accessibilityRole="button"
        >
          <Ionicons name="settings-outline" size={22} color={colors.icon} />
          <Text style={[styles.settingsText, { color: colors.icon }]}>{t('nav.settings')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          testID="drawer-logout"
          accessibilityLabel={t('nav.logout')}
          accessibilityRole="button"
        >
          <Ionicons name="log-out-outline" size={22} color={colors.error} />
          <Text style={[styles.logoutText, { color: colors.error }]}>{t('nav.logout')}</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={isCreateLabelVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          closeCreateLabelModal();
        }}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => {
            closeCreateLabelModal();
          }}
        >
          <Pressable
            style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={(event) => event.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('labels.createInputLabel')}
            </Text>
            <TextInput
              style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              value={newLabelValue}
              onChangeText={setNewLabelValue}
              placeholder={t('labels.newLabelPlaceholder')}
              placeholderTextColor={colors.placeholder}
              autoFocus
              editable={!createLabel.isPending}
              returnKeyType="done"
              onSubmitEditing={() => {
                void handleSubmitCreateLabel();
              }}
              testID="create-label-input"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
                onPress={() => {
                  closeCreateLabelModal();
                }}
                disabled={createLabel.isPending}
              >
                <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                  {t('labels.createCancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.modalPrimaryButton,
                  { backgroundColor: colors.primary },
                  !newLabelValue.trim() && styles.modalButtonDisabled,
                ]}
                onPress={() => {
                  void handleSubmitCreateLabel();
                }}
                disabled={!newLabelValue.trim() || createLabel.isPending}
                testID="create-label-submit"
              >
                <Text style={styles.modalPrimaryText}>
                  {createLabel.isPending ? t('settings.saving') : t('labels.createSave')}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

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
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('labels.renameInputLabel', { name: renameLabelTarget?.name ?? '' })}
            </Text>
            <TextInput
              style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder={t('labels.renamePlaceholder')}
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
                <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                  {t('labels.renameCancel')}
                </Text>
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
                  {renameLabel.isPending ? t('settings.saving') : t('labels.renameSave')}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={isServerPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isServerActionPending) {
            setIsServerPickerVisible(false);
          }
        }}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => {
            if (!isServerActionPending) {
              setIsServerPickerVisible(false);
            }
          }}
        >
          <Pressable
            style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={(event) => event.stopPropagation()}
            testID="server-picker-modal"
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('serverPicker.title')}
            </Text>

            <View style={styles.serverList}>
              {servers.length === 0 ? (
                <Text style={[styles.serverRowSubtext, { color: colors.textSecondary }]}>
                  {t('serverPicker.noServers')}
                </Text>
              ) : (
                servers.map((server) => {
                  const isActive = server.serverId === activeServerId;
                  return (
                    <TouchableOpacity
                      key={server.serverId}
                      style={[styles.serverRow, { borderColor: colors.borderLight }]}
                      onPress={() => {
                        if (!isActive) {
                          void handleSwitchToServer(server.serverId);
                        }
                      }}
                      disabled={isServerActionPending}
                      testID={`server-picker-row-${server.serverId}`}
                    >
                      <View style={styles.serverRowContent}>
                        <Text style={[styles.serverRowTitle, { color: colors.text }]} numberOfLines={1}>
                          {server.displayName || server.serverUrl}
                        </Text>
                        <Text style={[styles.serverRowSubtext, { color: colors.textSecondary }]} numberOfLines={1}>
                          {server.serverUrl}
                        </Text>
                      </View>
                      {isActive ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
                onPress={() => {
                  if (!isServerActionPending) {
                    setIsServerPickerVisible(false);
                  }
                }}
                disabled={isServerActionPending}
              >
                <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                  {t('common.close')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.modalPrimaryButton,
                  { backgroundColor: colors.primary },
                ]}
                onPress={() => {
                  handleOpenServerSetup();
                }}
                disabled={isServerActionPending}
                testID="server-picker-add-submit"
                accessibilityRole="button"
                accessibilityLabel={t('serverPicker.addButton')}
              >
                <Text style={styles.modalPrimaryText}>
                  {t('serverPicker.addButton')}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={isServerSetupVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isServerActionPending) {
            handleBackToDashboardFromServerSetup();
          }
        }}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => {
            if (!isServerActionPending) {
              handleBackToDashboardFromServerSetup();
            }
          }}
        >
          <Pressable
            style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={(event) => event.stopPropagation()}
            testID="server-setup-modal"
          >
            <ServerSetupGate
              testPrefix="server-picker-add"
              onServerReady={async () => {
                setIsServerActionPending(true);
                let initialRefreshOk = false;
                try {
                  const ok = await refreshServerPickerData();
                  initialRefreshOk = ok;
                  if (!ok) {
                    return;
                  }
                  await revalidateSession();
                  setIsServerSetupVisible(false);
                  setIsServerPickerVisible(false);
                  props.navigation.closeDrawer();
                } catch {
                  Alert.alert(t('common.error'), t('serverPicker.switchFailed'));
                } finally {
                  setIsServerActionPending(false);
                  if (initialRefreshOk) {
                    await refreshServerPickerData();
                  }
                }
              }}
              skipStoredServerCheck
              setupFooter={(
                <View style={styles.serverSetupActions}>
                  <TouchableOpacity
                    style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
                    onPress={() => {
                      handleBackToDashboardFromServerSetup();
                    }}
                    disabled={isServerActionPending}
                    testID="server-picker-add-cancel"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                  >
                    <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                      {t('common.close')}
                    </Text>
                  </TouchableOpacity>
                  {isServerActionPending ? (
                    <View style={styles.serverSetupPending}>
                      <ActivityIndicator color={colors.primary} />
                    </View>
                  ) : null}
                </View>
              )}
            />
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
  profileSection: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  profileTextWrap: {
    flex: 1,
  },
  displayName: {
    fontSize: 16,
    fontWeight: '600',
  },
  username: {
    fontSize: 13,
    marginTop: 2,
  },
  serverPickerHint: {
    fontSize: 12,
    marginTop: 4,
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
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingRight: 6,
  },
  labelNavItem: {
    flex: 1,
    paddingRight: 8,
  },
  labelMenuButton: {
    padding: 10,
    borderRadius: 8,
  },
  labelCount: {
    minWidth: 24,
    textAlign: 'right',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 6,
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
  serverList: {
    marginBottom: 12,
    gap: 8,
  },
  serverRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  serverRowContent: {
    flex: 1,
  },
  serverRowTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  serverRowSubtext: {
    fontSize: 12,
    marginTop: 2,
  },
  serverSetupActions: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  serverSetupPending: {
    marginLeft: 12,
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
