import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useTheme } from '../theme/ThemeContext';
import Banner from './Banner';

export default function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Banner
      visible={!isConnected}
      icon="cloud-offline-outline"
      text={t('offline.message')}
      backgroundColor={colors.offlineBanner}
      borderColor={colors.offlineBannerBorder}
      textColor={colors.offlineBannerText}
    />
  );
}
