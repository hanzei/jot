import { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import { DrawerContentScrollView } from '@react-navigation/drawer';
import { CommonActions } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Archive, ChevronRight, Clipboard, FileText, LogOut, Settings, Trash2, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/AuthContext';
import { useCreateLabel, useDeleteLabel, useLabelCounts, useLabels, useRenameLabel } from '../hooks/useLabels';
import { useTheme } from '../theme/ThemeContext';
import UserAvatar from './UserAvatar';
import { extractErrorMessage } from './drawer/utils';
import { useConfirm } from '../hooks/useConfirm';
import { styles } from './drawer/styles';
import LabelsSection from './drawer/LabelsSection';
import CreateLabelModal from './drawer/CreateLabelModal';
import RenameLabelModal from './drawer/RenameLabelModal';
import ServerPickerModal from './drawer/ServerPickerModal';

import type { Label } from '@jot/shared';
import type { MainDrawerParamList } from '../navigation/MainDrawer';

interface NavItem {
  name: keyof MainDrawerParamList;
  label: string;
  icon: LucideIcon;
}

// CommonActions.navigate()'s return type is widened to the full
// react-navigation Action union, which includes ResetAction — whose payload
// isn't exactOptionalPropertyTypes-clean — so a dispatch() call needs the
// result pinned back down to what dispatch actually accepts.
type DrawerDispatchAction = Parameters<DrawerContentComponentProps['navigation']['dispatch']>[0];

export default function DrawerContent(props: DrawerContentComponentProps) {
  const { user, logout, isLocalMode } = useAuth();
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
    // 'Settings' lives outside the drawer's own param list (it's a
    // RootStackParamList screen), so this goes through dispatch rather than
    // navigation.navigate.
    props.navigation.dispatch(CommonActions.navigate('Settings') as DrawerDispatchAction);
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const handleOpenServerPicker = useCallback(() => {
    setIsServerPickerVisible(true);
  }, []);

  const handleCloseServerPicker = useCallback(() => {
    setIsServerPickerVisible(false);
  }, []);

  const handleDismissedWithoutServers = useCallback(() => {
    // No server left to pick: return the user to the dashboard instead of
    // leaving the drawer open behind an empty picker.
    props.navigation.closeDrawer();
  }, [props.navigation]);

  const handleServerSwitched = useCallback((authenticated: boolean) => {
    // On a failed revalidation the navigator is already swapping to the login
    // stack, so this drawer is unmounting and there is nothing to close.
    if (authenticated) {
      props.navigation.closeDrawer();
    }
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

      <ServerPickerModal
        visible={isServerPickerVisible}
        onClose={handleCloseServerPicker}
        onSwitched={handleServerSwitched}
        onDismissedWithoutServers={handleDismissedWithoutServers}
      />

    </View>
  );
}
