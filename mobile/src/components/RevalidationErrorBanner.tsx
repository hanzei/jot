import React from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { TopBannerProps } from '../hooks/useTopBanners';
import Banner from './Banner';

/**
 * Shown when revalidateSession receives a permanent non-401 HTTP error
 * (e.g. 403, 422) from the server while the device is online. Network errors
 * and 5xx/timeout are transient and do not trigger this banner. Visibility and
 * safe-area ownership are decided centrally by {@link useVisibleTopBanners}.
 */
export default function RevalidationErrorBanner({ visible, applyTopInset }: TopBannerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Banner
      visible={visible}
      applyTopInset={applyTopInset}
      icon="warning-outline"
      text={t('offline.revalidationError')}
      backgroundColor={colors.warning}
      borderColor={colors.warningBorder}
      textColor={colors.warningText}
    />
  );
}
