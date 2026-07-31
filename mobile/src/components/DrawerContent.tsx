import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Alert,
  Modal,
  Pressable,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { DrawerContentScrollView, DrawerContentComponentProps } from '@react-navigation/drawer';
import { CommonActions } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Archive, CircleCheck, ChevronRight, Clipboard, FileText, LogOut, Pencil, Settings, Trash2, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/AuthContext';
import { useCreateLabel, useDeleteLabel, useLabelCounts, useLabels, useRenameLabel } from '../hooks/useLabels';
import { useTheme } from '../theme/ThemeContext';
import { getActiveServer, listServers, removeServer, renameServer, type ServerAccountEntry } from '../store/serverAccounts';
import { switchActiveServer } from '../api/client';
import UserAvatar from './UserAvatar';
import ServerSetupGate from './ServerSetupGate';
import { extractErrorMessage } from './drawer/utils';
import { useConfirm } from '../hooks/useConfirm';
import { styles } from './drawer/styles';
import LabelsSection from './drawer/LabelsSection';
import CreateLabelModal from './drawer/CreateLabelModal';
import RenameLabelModal from './drawer/RenameLabelModal';

import type { Label } from '@jot/shared';
import type { MainDrawerParamList } from '../navigation/MainDrawer';

interface NavItem {
  name: keyof MainDrawerParamList;
  label: string;
  icon: LucideIcon;
}

export default function DrawerContent(props: DrawerContentComponentProps) {
  const { user, logout, clearAuth, revalidateSession, isLocalMode } = useAuth();
  const { data: labels } = useLabels();
  const { data: labelCounts } = useLabelCounts();
  const createLabel = useCreateLabel();
  const renameLabel = useRenameLabel();
  const deleteLabel = useDeleteLabel();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const insets = useSafeAreaInsets();
  const topItems: NavItem[] = [
    { name: 'Notes', label: t('dashboard.tabNotes'), icon: FileText },
    ...(!isLocalMode ? [{ name: 'MyTasks' as const, label: t('dashboard.tabMyTasks'), icon: Clipboard }] : []),
  ];
  const bottomItems: NavItem[] = [
    { name: 'Archived', label: t('dashboard.tabArchive'), icon: Archive },
    { name: 'Trash', label: t('dashboard.tabBin'), icon: Trash2 },
  ];
  const [renameLabelTarget, setRenameLabelTarget] = useState<Label | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isCreateLabelVisible, setIsCreateLabelVisible] = useState(false);
  const [newLabelValue, setNewLabelValue] = useState('');
  const [isServerPickerVisible, setIsServerPickerVisible] = useState(false);
  const [isServerSetupVisible, setIsServerSetupVisible] = useState(false);
  const [renameServerTarget, setRenameServerTarget] = useState<ServerAccountEntry | null>(null);
  const [renameServerValue, setRenameServerValue] = useState('');
  const [servers, setServers] = useState<ServerAccountEntry[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [isServerActionPending, setIsServerActionPending] = useState(false);
  const serverSwitchingRef = useRef(false);
  // ids of labels currently being deleted, so each row can show a spinner
  // instead of sitting with no feedback for the ~5s write timeout (#698). A
  // set (not a single id) because the confirm dialog closes before the delete
  // resolves, so a second delete can start while the first is still in flight.
  const [deletingLabelIds, setDeletingLabelIds] = useState<Set<string>>(() => new Set());

  const activeRoute = props.state.routes[props.state.index]?.name;
  const activeParams = props.state.routes[props.state.index]?.params as
    | { labelId?: string } | undefined;
  const activeLabelId = activeRoute === 'Notes' ? activeParams?.labelId : undefined;

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('nav.logoutConfirmTitle'),
      message: t('nav.logoutConfirmMessage'),
      confirmLabel: t('nav.logout'),
      destructive: true,
    });
    if (confirmed) logout();
  }, [confirm, logout, t]);

  const handleNavPress = useCallback((name: keyof MainDrawerParamList) => {
    if (name === 'Notes') {
      props.navigation.navigate('Notes', { labelId: undefined, labelName: undefined });
    } else {
      props.navigation.navigate(name);
    }
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const handleLabelNavigate = useCallback((labelId: string, labelName: string) => {
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

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
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

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const openRenameModal = useCallback((label: Label) => {
    setRenameLabelTarget(label);
    setRenameValue(label.name);
  }, []);

  const handleDeleteLabel = useCallback(async (label: Label) => {
    const confirmed = await confirm({
      title: t('labels.deleteConfirmTitle'),
      message: t('labels.deleteConfirmMessage', { name: label.name }),
      confirmLabel: t('labels.delete'),
      destructive: true,
    });
    if (!confirmed) return;
    setDeletingLabelIds((prev) => new Set(prev).add(label.id));
    try {
      await deleteLabel.mutateAsync({ labelId: label.id });
      handleDeleteLabelSuccess(label.id);
      Alert.alert(t('labels.deleteSuccess'));
    } catch (error) {
      Alert.alert(t('common.error'), extractErrorMessage(error, t('labels.deleteError')));
    } finally {
      setDeletingLabelIds((prev) => {
        const next = new Set(prev);
        next.delete(label.id);
        return next;
      });
    }
  }, [confirm, deleteLabel, handleDeleteLabelSuccess, t]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
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

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const closeCreateLabelModal = useCallback(() => {
    if (createLabel.isPending) {
      return;
    }
    setIsCreateLabelVisible(false);
    setNewLabelValue('');
  }, [createLabel.isPending]);

  const closeRenameModal = useCallback(() => {
    if (!renameLabel.isPending) {
      setRenameLabelTarget(null);
    }
  }, [renameLabel.isPending]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const handleCreateLabelPress = useCallback(() => {
    setNewLabelValue('');
    setIsCreateLabelVisible(true);
  }, []);

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

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
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

      // revalidateSession returns false when the target server's stored session
      // is no longer valid (expired, or the account was deleted): it clears auth
      // so the app redirects to that server's login screen. Skip closeDrawer in
      // that case (the navigator is already unmounting) and prompt the user to
      // sign in again rather than reporting a switch failure.
      const authenticated = await revalidateSession();
      setIsServerPickerVisible(false);
      if (authenticated) {
        props.navigation.closeDrawer();
      } else {
        const targetServer = servers.find((server) => server.serverId === serverId);
        Alert.alert(
          t('serverPicker.sessionExpiredTitle'),
          t('serverPicker.sessionExpiredMessage', {
            server: targetServer?.displayName || targetServer?.serverUrl || '',
          }),
        );
      }
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
  }, [isServerActionPending, loadServerPickerData, props.navigation, revalidateSession, refreshServerPickerData, servers, t]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const handleOpenServerSetup = useCallback(() => {
    if (isServerActionPending) {
      return;
    }
    setIsServerPickerVisible(false);
    setIsServerSetupVisible(true);
  }, [isServerActionPending]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const handleDeleteServer = useCallback((server: ServerAccountEntry) => {
    if (isServerActionPending) {
      return;
    }
    Alert.alert(
      t('serverPicker.deleteConfirmTitle'),
      t('serverPicker.deleteConfirmMessage', { name: server.displayName || server.serverUrl }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('serverPicker.deleteButton'),
          style: 'destructive',
          onPress: async () => {
            setIsServerActionPending(true);
            try {
              const removed = await removeServer(server.serverId);
              if (!removed) {
                Alert.alert(t('common.error'), t('serverPicker.deleteFailed'));
                return;
              }
              const [serverList, newActiveServer] = await Promise.all([listServers(), getActiveServer()]);
              setServers(serverList);
              setActiveServerId(newActiveServer?.serverId ?? null);
              if (serverList.length === 0) {
                setIsServerPickerVisible(false);
                clearAuth();
              } else if (server.serverId === activeServerId && newActiveServer) {
                await switchActiveServer(newActiveServer.serverId);
                await revalidateSession();
              }
            } catch {
              Alert.alert(t('common.error'), t('serverPicker.deleteFailed'));
            } finally {
              setIsServerActionPending(false);
            }
          },
        },
      ],
    );
  }, [isServerActionPending, activeServerId, clearAuth, revalidateSession, t]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const handleOpenRenameServer = useCallback((server: ServerAccountEntry) => {
    if (isServerActionPending) {
      return;
    }
    setRenameServerValue(server.displayName ?? '');
    setRenameServerTarget(server);
    setIsServerPickerVisible(false);
  }, [isServerActionPending]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const handleDismissRenameServer = useCallback(() => {
    if (isServerActionPending) {
      return;
    }
    setRenameServerTarget(null);
    setRenameServerValue('');
    setIsServerPickerVisible(true);
  }, [isServerActionPending]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const handleSubmitRenameServer = useCallback(async () => {
    if (!renameServerTarget || isServerActionPending) {
      return;
    }
    setIsServerActionPending(true);
    try {
      const trimmed = renameServerValue.trim();
      const ok = await renameServer(renameServerTarget.serverId, trimmed);
      if (!ok) {
        Alert.alert(t('common.error'), t('serverPicker.renameFailed'));
        return;
      }
      setServers(prev =>
        prev.map(s =>
          s.serverId === renameServerTarget.serverId
            ? { ...s, displayName: trimmed.length > 0 ? trimmed : undefined }
            : s,
        ),
      );
      setRenameServerTarget(null);
      setRenameServerValue('');
      setIsServerPickerVisible(true);
    } catch {
      Alert.alert(t('common.error'), t('serverPicker.renameFailed'));
    } finally {
      setIsServerActionPending(false);
    }
  }, [renameServerTarget, renameServerValue, isServerActionPending, t]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- pre-existing, tracked in #777
  const handleBackToDashboardFromServerSetup = useCallback(() => {
    setIsServerSetupVisible(false);
    if (servers.length > 0) {
      setIsServerPickerVisible(true);
    } else {
      props.navigation.closeDrawer();
    }
  }, [props.navigation, servers.length]);

  const handleConfirmCancelSetup = useCallback(() => {
    if (isServerActionPending) {
      return;
    }
    Alert.alert(
      t('serverPicker.cancelSetupTitle'),
      t('serverPicker.cancelSetupMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('serverPicker.cancelSetupConfirm'), onPress: handleBackToDashboardFromServerSetup },
      ],
    );
  }, [isServerActionPending, t, handleBackToDashboardFromServerSetup]);

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
        {isLocalMode ? (
          <View style={styles.profileSection} testID="drawer-profile-button">
            <UserAvatar
              userId={user?.id ?? ''}
              username={user?.username ?? ''}
              hasProfileIcon={user?.has_profile_icon}
              iconVersion={user?.updated_at}
              size="large"
            />
            <View style={styles.profileTextWrap}>
              <Text style={[styles.displayName, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
            </View>
          </View>
        ) : (
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
              iconVersion={user?.updated_at}
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
            <ChevronRight size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}

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
                <item.icon
                  size={22}
                  color={isActive ? colors.primary : colors.icon}
                />
                <Text style={[styles.navItemText, { color: colors.icon }, isActive && { color: colors.primary, fontWeight: '600' }]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}

          <LabelsSection
            labels={labels ?? []}
            labelCounts={labelCounts}
            activeLabelId={activeLabelId}
            onLabelNavigate={handleLabelNavigate}
            onOpenRenameModal={openRenameModal}
            onDeleteLabel={handleDeleteLabel}
            onCreateLabelPress={handleCreateLabelPress}
            deletingLabelIds={deletingLabelIds}
          />

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
                <item.icon
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

      <View
        style={[styles.bottomSection, { paddingBottom: Math.max(insets.bottom, 16) }]}
        testID="drawer-bottom-section"
      >
        <View style={[styles.divider, { backgroundColor: colors.divider }]} />
        <TouchableOpacity
          style={styles.bottomNavButton}
          onPress={handleSettingsPress}
          testID="drawer-settings"
          accessibilityLabel={t('nav.settings')}
          accessibilityRole="button"
        >
          <Settings size={22} color={colors.icon} />
          <Text style={[styles.bottomNavText, { color: colors.icon }]}>{t('nav.settings')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.bottomNavButton}
          onPress={handleLogout}
          testID="drawer-logout"
          accessibilityLabel={t('nav.logout')}
          accessibilityRole="button"
        >
          <LogOut size={22} color={colors.error} />
          <Text style={[styles.bottomNavText, { color: colors.error }]}>{t('nav.logout')}</Text>
        </TouchableOpacity>
      </View>

      <CreateLabelModal
        visible={isCreateLabelVisible}
        value={newLabelValue}
        onChange={setNewLabelValue}
        isPending={createLabel.isPending}
        onSubmit={() => { void handleSubmitCreateLabel(); }}
        onClose={closeCreateLabelModal}
      />

      <RenameLabelModal
        target={renameLabelTarget}
        value={renameValue}
        onChange={setRenameValue}
        isPending={renameLabel.isPending}
        onSubmit={() => { void handleSubmitRename(); }}
        onClose={closeRenameModal}
      />

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
                    <View
                      key={server.serverId}
                      style={[styles.serverRow, { borderColor: colors.borderLight }]}
                    >
                      <TouchableOpacity
                        style={styles.serverRowPressable}
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
                          {server.displayName ? (
                            <Text style={[styles.serverRowSubtext, { color: colors.textSecondary }]} numberOfLines={1}>
                              {server.serverUrl}
                            </Text>
                          ) : null}
                        </View>
                        {isActive ? <CircleCheck size={20} color={colors.primary} /> : null}
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleOpenRenameServer(server)}
                        disabled={isServerActionPending}
                        style={styles.serverRowIconButton}
                        hitSlop={{ top: 8, right: 0, bottom: 8, left: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('serverPicker.renameButton')}
                        testID={`server-picker-rename-${server.serverId}`}
                      >
                        <Pencil size={18} color={colors.icon} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleDeleteServer(server)}
                        disabled={isServerActionPending}
                        style={styles.serverRowIconButton}
                        hitSlop={{ top: 8, right: 0, bottom: 8, left: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('serverPicker.deleteButton')}
                        testID={`server-picker-delete-${server.serverId}`}
                      >
                        <Trash2 size={18} color={colors.error} />
                      </TouchableOpacity>
                    </View>
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
                  { backgroundColor: colors.primary },
                ]}
                onPress={handleOpenServerSetup}
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
        onRequestClose={handleConfirmCancelSetup}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={handleConfirmCancelSetup}
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
                  const authenticated = await revalidateSession();
                  setIsServerSetupVisible(false);
                  setIsServerPickerVisible(false);
                  if (authenticated) {
                    props.navigation.closeDrawer();
                  }
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
                    onPress={handleBackToDashboardFromServerSetup}
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

      <Modal
        visible={renameServerTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={handleDismissRenameServer}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={handleDismissRenameServer}
        >
          <Pressable
            style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={(event) => event.stopPropagation()}
            testID="server-rename-modal"
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('serverPicker.renameTitle')}
            </Text>
            <TextInput
              style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              value={renameServerValue}
              onChangeText={setRenameServerValue}
              placeholder={t('serverPicker.renamePlaceholder')}
              placeholderTextColor={colors.placeholder}
              autoFocus
              editable={!isServerActionPending}
              returnKeyType="done"
              onSubmitEditing={() => {
                void handleSubmitRenameServer();
              }}
              testID="server-rename-input"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
                onPress={handleDismissRenameServer}
                disabled={isServerActionPending}
                testID="server-rename-cancel"
              >
                <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  { backgroundColor: colors.primary },
                  isServerActionPending && styles.modalButtonDisabled,
                ]}
                onPress={() => {
                  void handleSubmitRenameServer();
                }}
                disabled={isServerActionPending}
                testID="server-rename-submit"
              >
                <Text style={styles.modalPrimaryText}>
                  {isServerActionPending ? t('settings.saving') : t('serverPicker.renameSave')}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
