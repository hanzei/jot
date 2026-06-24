import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useSSEContext } from '../store/SSEContext';
import { useTheme } from '../theme/ThemeContext';
import Banner from './Banner';

/**
 * Shown when the device is online but the SSE connection to the server has
 * been down for more than 3 seconds. Covers both initial cold-start (server
 * unreachable from the beginning) and mid-session disconnections. Gated on
 * isConnected so it never competes with the offline banner.
 */
export default function SSEReconnectBanner() {
  const { isConnected } = useNetworkStatus();
  const { sseReconnecting } = useSSEContext();
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Banner
      visible={isConnected && sseReconnecting}
      icon="cloud-offline-outline"
      text={t('offline.serverConnecting')}
      backgroundColor={colors.warning}
      borderColor={colors.warningBorder}
      textColor={colors.warningText}
    />
  );
}
