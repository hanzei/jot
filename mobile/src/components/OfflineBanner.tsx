import React from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { TopBannerProps } from '../hooks/useTopBanners';
import Banner from './Banner';

/**
 * Shown while the device is offline. Visibility and safe-area ownership are
 * decided centrally by {@link useVisibleTopBanners}; this component only
 * supplies the presentation.
 */
export default function OfflineBanner({ visible, applyTopInset }: TopBannerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Banner
      visible={visible}
      applyTopInset={applyTopInset}
      icon="cloud-offline-outline"
      text={t('offline.message')}
      backgroundColor={colors.offlineBanner}
      borderColor={colors.offlineBannerBorder}
      textColor={colors.offlineBannerText}
    />
  );
}
