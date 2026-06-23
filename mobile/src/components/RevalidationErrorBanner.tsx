import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/AuthContext';
import { useOfflineContext } from '../store/OfflineContext';
import { useTheme } from '../theme/ThemeContext';
import Banner from './Banner';

/**
 * Shown when revalidateSession receives a permanent non-401 HTTP error
 * (e.g. 403, 422) from the server while the device is online. Network errors
 * and 5xx/timeout are transient and do not trigger this banner. Stacks below
 * the SyncErrorBanner, so it skips the top safe-area inset when that banner
 * is already shown.
 */
export default function RevalidationErrorBanner() {
  const { revalidationFailed } = useAuth();
  const { isConnected, syncError } = useOfflineContext();
  const { colors } = useTheme();
  const { t } = useTranslation();

  const otherBannerAbove = !isConnected || syncError;

  return (
    <Banner
      visible={isConnected && revalidationFailed}
      applyTopInset={!otherBannerAbove}
      icon="warning-outline"
      text={t('offline.revalidationError')}
      backgroundColor={colors.warning}
      borderColor={colors.warningBorder}
      textColor={colors.warningText}
    />
  );
}
