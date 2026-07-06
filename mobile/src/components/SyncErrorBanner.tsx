import React from 'react';
import { TriangleAlert } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { TopBannerProps } from '../hooks/useTopBanners';
import Banner from './Banner';

/**
 * Shown when the device is online but the sync queue has failed to drain too
 * many times in a row (see OfflineContext's MAX_CONSECUTIVE_DRAIN_FAILURES).
 * Visibility and safe-area ownership are decided centrally by
 * {@link useVisibleTopBanners}.
 */
export default function SyncErrorBanner({ visible, applyTopInset }: TopBannerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Banner
      visible={visible}
      applyTopInset={applyTopInset}
      icon={TriangleAlert}
      text={t('offline.syncError')}
      backgroundColor={colors.warning}
      borderColor={colors.warningBorder}
      textColor={colors.warningText}
    />
  );
}
