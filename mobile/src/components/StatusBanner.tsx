import { useState } from 'react';
import { CloudOff, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { StatusBannerKey, TopBannerProps } from '../hooks/useTopBanners';
import Banner from './Banner';

interface StatusBannerProps extends Omit<TopBannerProps, 'visible'> {
  /** The status to report, or null to hide the banner. */
  status: StatusBannerKey | null;
}

const ICONS: Record<StatusBannerKey, LucideIcon> = {
  offline: CloudOff,
  revalidation: TriangleAlert,
  sseReconnect: CloudOff,
  syncError: TriangleAlert,
};

const TEXT_KEYS: Record<StatusBannerKey, string> = {
  offline: 'offline.message',
  revalidation: 'offline.revalidationError',
  sseReconnect: 'offline.serverConnecting',
  syncError: 'offline.syncError',
};

const TEST_IDS: Record<StatusBannerKey, string> = {
  offline: 'offline-banner',
  revalidation: 'revalidation-banner',
  sseReconnect: 'server-connecting-banner',
  syncError: 'sync-error-banner',
};

/**
 * The one connection/session status banner ({@link useTopBanners} picks which
 * status). A single {@link Banner} whose content changes, rather than one
 * banner per status: going from one status to another then just swaps the
 * text, instead of fading one banner out while another fades in, which
 * briefly stacked two and let the outgoing one slide under the status bar.
 */
export default function StatusBanner({ status, applyTopInset }: StatusBannerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // Keep showing the last status while the banner fades out after it clears.
  const [lastStatus, setLastStatus] = useState(status);
  if (status !== null && status !== lastStatus) setLastStatus(status);
  const shown = status ?? lastStatus;
  if (shown === null) return null;

  const offline = shown === 'offline';
  return (
    <Banner
      visible={status !== null}
      applyTopInset={applyTopInset}
      testID={TEST_IDS[shown]}
      icon={ICONS[shown]}
      text={t(TEXT_KEYS[shown])}
      backgroundColor={offline ? colors.offlineBanner : colors.warning}
      borderColor={offline ? colors.offlineBannerBorder : colors.warningBorder}
      textColor={offline ? colors.offlineBannerText : colors.warningText}
    />
  );
}
