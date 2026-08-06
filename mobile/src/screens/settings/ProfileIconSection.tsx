import { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../store/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { uploadProfileIcon, deleteProfileIcon } from '../../api/settings';
import { useActiveServerBaseUrl } from '../../hooks/useActiveServerBaseUrl';
import { useProfileIcon } from '../../hooks/useProfileIcon';
import { displayMessage, extractApiError } from '../../i18n/utils';
import { styles } from './styles';

export default function ProfileIconSection() {
  const { user, setUser } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const activeServerBaseUrl = useActiveServerBaseUrl();
  const isMountedRef = useRef(true);

  const [iconUploading, setIconUploading] = useState(false);
  const [iconUploadPercent, setIconUploadPercent] = useState(0);
  const [iconDeleting, setIconDeleting] = useState(false);
  const [iconError, setIconError] = useState('');

  const hasProfileIcon = user?.has_profile_icon ?? false;
  const iconVersion = user?.updated_at ?? '';
  const settingsIconNetworkUrl =
    hasProfileIcon && user ? `${activeServerBaseUrl}/api/v1/users/${user.id}/profile-icon` : '';
  const localIconUri = useProfileIcon(user?.id, hasProfileIcon, iconVersion, settingsIconNetworkUrl);

  const initials = user
    ? (user.first_name?.[0] ?? user.username?.[0] ?? '').toUpperCase()
    : '';

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleUploadIcon = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (result.canceled || !result.assets?.[0]) return;

    setIconError('');
    setIconUploading(true);
    setIconUploadPercent(0);
    try {
      const updatedUser = await uploadProfileIcon(result.assets[0].uri, (percent) => {
        if (isMountedRef.current) {
          setIconUploadPercent(percent);
        }
      });
      if (!isMountedRef.current) return;
      setUser(updatedUser);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      setIconError(extractApiError(err) ?? 'settings.iconUploadFailed');
    } finally {
      if (isMountedRef.current) {
        setIconUploading(false);
        setIconUploadPercent(0);
      }
    }
  }, [setUser]);

  const handleDeleteIcon = useCallback(async () => {
    setIconError('');
    setIconDeleting(true);
    try {
      await deleteProfileIcon();
      if (!isMountedRef.current) return;
      setUser(prev =>
        prev ? { ...prev, has_profile_icon: false, updated_at: new Date().toISOString() } : prev,
      );
    } catch {
      if (!isMountedRef.current) return;
      setIconError('settings.iconDeleteFailed');
    } finally {
      if (isMountedRef.current) setIconDeleting(false);
    }
  }, [setUser]);

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.profileIconSection')}</Text>
      <View style={styles.profileIconRow}>
        <View>
          {hasProfileIcon && user ? (
            <Image
              source={{ uri: localIconUri ?? settingsIconNetworkUrl }}
              style={styles.profileAvatar}
            />
          ) : (
            <View style={[styles.profileAvatarFallback, { backgroundColor: colors.primary }]}>
              <Text style={styles.profileAvatarText}>{initials}</Text>
            </View>
          )}
        </View>
        <View style={styles.profileIconActions}>
          <TouchableOpacity
            style={[styles.uploadButton, { backgroundColor: colors.primary }]}
            onPress={handleUploadIcon}
            disabled={iconUploading || iconDeleting}
            testID="settings-upload-icon"
            accessibilityLabel={t('settings.uploadIconButton')}
            accessibilityRole="button"
          >
            {iconUploading ? (
              iconUploadPercent > 0 ? (
                <Text style={styles.uploadButtonText}>
                  {t('settings.iconUploadProgress', { percent: iconUploadPercent })}
                </Text>
              ) : (
                <ActivityIndicator size="small" color="#fff" />
              )
            ) : (
              <Text style={styles.uploadButtonText}>{t('settings.uploadIconButton')}</Text>
            )}
          </TouchableOpacity>
          {hasProfileIcon && (
            <TouchableOpacity
              style={styles.removeIconButton}
              onPress={handleDeleteIcon}
              disabled={iconUploading || iconDeleting}
              testID="settings-remove-icon"
              accessibilityLabel={t('settings.removeIconButton')}
              accessibilityRole="button"
            >
              <Text style={[styles.removeIconText, { color: colors.error }]}>
                {iconDeleting ? t('settings.iconRemoving') : t('settings.removeIconButton')}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      {iconError !== '' && (
        <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, iconError)}</Text>
      )}
    </View>
  );
}
