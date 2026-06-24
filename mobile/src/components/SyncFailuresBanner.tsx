import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useOfflineContext } from '../store/OfflineContext';
import { useAuth } from '../store/AuthContext';
import { useSSEContext } from '../store/SSEContext';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/RootNavigator';
import Banner from './Banner';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

/**
 * Surfaces the count of changes the server permanently rejected (dead-lettered
 * ops, #492) as a dismissible, tappable banner that opens the review screen
 * (#493). Tapping links to the per-failure resolution list; dismissing hides it
 * until a new failure arrives (OfflineContext re-surfaces it when the count
 * grows). Stacks below the offline / sync-error banners, so it skips the top
 * safe-area inset when one of those is already shown.
 */
export default function SyncFailuresBanner() {
  const {
    isConnected,
    syncError,
    syncFailureCount,
    syncFailuresBannerDismissed,
    dismissSyncFailuresBanner,
  } = useOfflineContext();
  const { revalidationFailed } = useAuth();
  const { sseReconnecting } = useSSEContext();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp>();

  const otherBannerAbove = !isConnected || sseReconnecting || syncError || revalidationFailed;

  return (
    <Banner
      visible={syncFailureCount > 0 && !syncFailuresBannerDismissed}
      applyTopInset={!otherBannerAbove}
      icon="alert-circle-outline"
      text={t('syncFailures.bannerCount', { count: syncFailureCount })}
      backgroundColor={colors.warning}
      borderColor={colors.warningBorder}
      textColor={colors.warningText}
      onPress={() => navigation.navigate('SyncFailures')}
      onDismiss={dismissSyncFailuresBanner}
      accessibilityLabel={t('syncFailures.bannerCount', { count: syncFailureCount })}
      dismissAccessibilityLabel={t('common.close')}
      testID="sync-failures-banner"
    />
  );
}
