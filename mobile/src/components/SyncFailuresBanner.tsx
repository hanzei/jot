import React from 'react';
import { CircleAlert } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useOfflineContext } from '../store/OfflineContext';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { TopBannerProps } from '../hooks/useTopBanners';
import Banner from './Banner';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

/**
 * Surfaces the count of changes the server permanently rejected (dead-lettered
 * ops, #492) as a dismissible, tappable banner that opens the review screen
 * (#493). Tapping links to the per-failure resolution list; dismissing hides it
 * until a new failure arrives (OfflineContext re-surfaces it when the count
 * grows). Visibility and safe-area ownership are decided centrally by
 * {@link useVisibleTopBanners}; the count and dismiss action come from context.
 */
export default function SyncFailuresBanner({ visible, applyTopInset }: TopBannerProps) {
  const { syncFailureCount, dismissSyncFailuresBanner } = useOfflineContext();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp>();

  return (
    <Banner
      visible={visible}
      applyTopInset={applyTopInset}
      icon={CircleAlert}
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
