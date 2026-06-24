import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOfflineContext } from '../store/OfflineContext';
import { useSSEContext } from '../store/SSEContext';
import { useTheme } from '../theme/ThemeContext';
import Banner from './Banner';

/**
 * Shown when the device is online but the sync queue has failed to drain too
 * many times in a row (see OfflineContext's MAX_CONSECUTIVE_DRAIN_FAILURES).
 * Gated on isConnected so it never competes with the offline banner.
 */
export default function SyncErrorBanner() {
  const { isConnected, syncError } = useOfflineContext();
  const { sseReconnecting } = useSSEContext();
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Banner
      visible={isConnected && syncError}
      applyTopInset={!sseReconnecting}
      icon="warning-outline"
      text={t('offline.syncError')}
      backgroundColor={colors.warning}
      borderColor={colors.warningBorder}
      textColor={colors.warningText}
    />
  );
}
