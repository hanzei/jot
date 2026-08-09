import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { CircleCheck, Pencil, Trash2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { useAuth } from '../../store/AuthContext';
import { useServerAccounts } from '../../hooks/useServerAccounts';
import { removeServer, renameServer, type ServerAccountEntry } from '../../store/serverAccounts';
import { switchActiveServer } from '../../api/client';
import ServerSetupGate from '../ServerSetupGate';
import { styles } from './styles';

interface ServerPickerModalProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Fired after a completed switch, with the result of revalidating the target
   * server's stored session: `true` means the user is now signed in there,
   * `false` means they were dropped on that server's login screen. Hosts use it
   * for follow-up only — the modal has already closed itself either way.
   */
  onSwitched?: (authenticated: boolean) => void;
  /**
   * Fired alongside `onClose` when the user backs out of adding a server and
   * none is configured, so the picker has nothing left to show. The drawer uses
   * it to drop the user back on the dashboard rather than leaving an open
   * drawer behind an empty picker; the login screen has nowhere to go and omits
   * it.
   */
  onDismissedWithoutServers?: () => void;
}

/**
 * The registered-server list, with rename / remove / add. Rendered from the
 * drawer while signed in and from the login screen while signed out (#855), so
 * a user whose active server rejects them can still reach the others.
 *
 * Rename and add-server render *inside* this one modal rather than as nested
 * ones: stacking transparent modals doubles the backdrop, and swapping the card
 * contents avoids the close-then-reopen dance the drawer used to do.
 */
export default function ServerPickerModal({
  visible,
  onClose,
  onSwitched,
  onDismissedWithoutServers,
}: ServerPickerModalProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { clearAuth, revalidateSession } = useAuth();
  const { servers, activeServerId, reload } = useServerAccounts();

  const [mode, setMode] = useState<'list' | 'rename' | 'add'>('list');
  const [renameTarget, setRenameTarget] = useState<ServerAccountEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isPending, setIsPending] = useState(false);
  const switchingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      await reload();
      return true;
    } catch (error) {
      console.warn('Failed to load server picker data:', error);
      Alert.alert(t('common.error'), t('serverPicker.switchFailed'));
      return false;
    }
  }, [reload, t]);

  // Reopening always lands on the list, even if the modal was closed by its host
  // mid-rename. Adjusting during render rather than in an effect — the state
  // derives from `visible`, so an effect would render the stale mode first.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setMode('list');
      setRenameTarget(null);
      setRenameValue('');
    }
  }

  // Deliberately depends on `reload` (stable) rather than `refresh` (closes over
  // `t`): an unstable `t` identity would re-run this on every render, and each
  // run sets state, which is a self-sustaining reload loop. A failed read on
  // open is logged rather than alerted — the user did not ask for anything yet.
  useEffect(() => {
    if (visible) {
      void reload().catch((error: unknown) => {
        console.warn('Failed to load server picker data:', error);
      });
    }
  }, [visible, reload]);

  const closeIfIdle = useCallback(() => {
    if (!isPending) {
      onClose();
    }
  }, [isPending, onClose]);

  const handleSwitchToServer = useCallback(async (serverId: string) => {
    if (isPending || switchingRef.current) {
      return;
    }
    switchingRef.current = true;
    setIsPending(true);
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
      // so the app redirects to that server's login screen. Prompt the user to
      // sign in again rather than reporting a switch failure — the switch itself
      // worked, and landing on that server's login form is a correct outcome.
      const authenticated = await revalidateSession();
      onClose();
      if (!authenticated) {
        const targetServer = servers.find((server) => server.serverId === serverId);
        Alert.alert(
          t('serverPicker.sessionExpiredTitle'),
          t('serverPicker.sessionExpiredMessage', {
            server: targetServer?.displayName || targetServer?.serverUrl || '',
          }),
        );
      }
      onSwitched?.(authenticated);
    } catch {
      Alert.alert(t('common.error'), t('serverPicker.switchFailed'));
    } finally {
      setIsPending(false);
      switchingRef.current = false;
      if (switchedSuccessfully) {
        try {
          await reload();
        } catch (error) {
          console.warn('Failed to refresh server picker data after successful switch:', error);
        }
      } else {
        await refresh();
      }
    }
  }, [isPending, onClose, onSwitched, refresh, reload, revalidateSession, servers, t]);

  const handleDeleteServer = useCallback((server: ServerAccountEntry) => {
    if (isPending) {
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
            setIsPending(true);
            try {
              const removed = await removeServer(server.serverId);
              if (!removed) {
                Alert.alert(t('common.error'), t('serverPicker.deleteFailed'));
                return;
              }
              const next = await reload();
              if (next.servers.length === 0) {
                onClose();
                clearAuth();
              } else if (server.serverId === activeServerId && next.activeServerId) {
                await switchActiveServer(next.activeServerId);
                await revalidateSession();
              }
            } catch {
              Alert.alert(t('common.error'), t('serverPicker.deleteFailed'));
            } finally {
              setIsPending(false);
            }
          },
        },
      ],
    );
  }, [activeServerId, clearAuth, isPending, onClose, reload, revalidateSession, t]);

  const handleOpenRename = useCallback((server: ServerAccountEntry) => {
    if (isPending) {
      return;
    }
    setRenameValue(server.displayName ?? '');
    setRenameTarget(server);
    setMode('rename');
  }, [isPending]);

  const handleBackToList = useCallback(() => {
    if (isPending) {
      return;
    }
    setRenameTarget(null);
    setRenameValue('');
    setMode('list');
  }, [isPending]);

  const handleSubmitRename = useCallback(async () => {
    if (!renameTarget || isPending) {
      return;
    }
    setIsPending(true);
    try {
      const ok = await renameServer(renameTarget.serverId, renameValue.trim());
      if (!ok) {
        Alert.alert(t('common.error'), t('serverPicker.renameFailed'));
        return;
      }
      await reload();
      setRenameTarget(null);
      setRenameValue('');
      setMode('list');
    } catch {
      Alert.alert(t('common.error'), t('serverPicker.renameFailed'));
    } finally {
      setIsPending(false);
    }
  }, [isPending, reload, renameTarget, renameValue, t]);

  const handleOpenAddServer = useCallback(() => {
    if (isPending) {
      return;
    }
    setMode('add');
  }, [isPending]);

  const handleCancelAddServer = useCallback(() => {
    setMode('list');
    if (servers.length === 0) {
      onClose();
      onDismissedWithoutServers?.();
    }
  }, [onClose, onDismissedWithoutServers, servers.length]);

  const handleConfirmCancelAddServer = useCallback(() => {
    if (isPending) {
      return;
    }
    Alert.alert(
      t('serverPicker.cancelSetupTitle'),
      t('serverPicker.cancelSetupMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('serverPicker.cancelSetupConfirm'), onPress: handleCancelAddServer },
      ],
    );
  }, [handleCancelAddServer, isPending, t]);

  const handleServerAdded = useCallback(async () => {
    setIsPending(true);
    try {
      const ok = await refresh();
      if (!ok) {
        return;
      }
      const authenticated = await revalidateSession();
      setMode('list');
      onClose();
      onSwitched?.(authenticated);
    } catch {
      Alert.alert(t('common.error'), t('serverPicker.addFailed'));
    } finally {
      setIsPending(false);
    }
  }, [onClose, onSwitched, refresh, revalidateSession, t]);

  const handleDismiss = useCallback(() => {
    if (mode === 'add') {
      handleConfirmCancelAddServer();
      return;
    }
    if (mode === 'rename') {
      handleBackToList();
      return;
    }
    closeIfIdle();
  }, [closeIfIdle, handleBackToList, handleConfirmCancelAddServer, mode]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleDismiss}
    >
      <Pressable
        style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
        onPress={handleDismiss}
      >
        <Pressable
          style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
          onPress={(event) => event.stopPropagation()}
          testID={
            mode === 'add'
              ? 'server-setup-modal'
              : mode === 'rename'
                ? 'server-rename-modal'
                : 'server-picker-modal'
          }
        >
          {mode === 'add' ? (
            <ServerSetupGate
              testPrefix="server-picker-add"
              onServerReady={handleServerAdded}
              skipStoredServerCheck
              setupFooter={(
                <View style={styles.serverSetupActions}>
                  <TouchableOpacity
                    style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
                    onPress={handleCancelAddServer}
                    disabled={isPending}
                    testID="server-picker-add-cancel"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                  >
                    <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                      {t('common.close')}
                    </Text>
                  </TouchableOpacity>
                  {isPending ? (
                    <View style={styles.serverSetupPending}>
                      <ActivityIndicator color={colors.primary} />
                    </View>
                  ) : null}
                </View>
              )}
            />
          ) : mode === 'rename' ? (
            <>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                {t('serverPicker.renameTitle')}
              </Text>
              <TextInput
                style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
                value={renameValue}
                onChangeText={setRenameValue}
                placeholder={t('serverPicker.renamePlaceholder')}
                placeholderTextColor={colors.placeholder}
                autoFocus
                editable={!isPending}
                returnKeyType="done"
                onSubmitEditing={() => {
                  void handleSubmitRename();
                }}
                testID="server-rename-input"
              />
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
                  onPress={handleBackToList}
                  disabled={isPending}
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
                    isPending && styles.modalButtonDisabled,
                  ]}
                  onPress={() => {
                    void handleSubmitRename();
                  }}
                  disabled={isPending}
                  testID="server-rename-submit"
                >
                  <Text style={styles.modalPrimaryText}>
                    {isPending ? t('settings.saving') : t('serverPicker.renameSave')}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
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
                          disabled={isPending}
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
                          onPress={() => handleOpenRename(server)}
                          disabled={isPending}
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
                          disabled={isPending}
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
                  onPress={closeIfIdle}
                  disabled={isPending}
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
                  onPress={handleOpenAddServer}
                  disabled={isPending}
                  testID="server-picker-add-submit"
                  accessibilityRole="button"
                  accessibilityLabel={t('serverPicker.addButton')}
                >
                  <Text style={styles.modalPrimaryText}>
                    {t('serverPicker.addButton')}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
