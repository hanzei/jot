import { CloudOff, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { StatusBannerKey } from '../hooks/useTopBanners';
import Banner from './Banner';

interface StatusPresentation {
  icon: LucideIcon;
  textKey: string;
  /** `offline-banner` is what the Maestro flows assert on. */
  testID: string;
  /** Offline uses the dark offline colors; every other status is a warning. */
  tone: 'offline' | 'warning';
}

const STATUSES: Record<StatusBannerKey, StatusPresentation> = {
  offline: { icon: CloudOff, textKey: 'offline.message', testID: 'offline-banner', tone: 'offline' },
  revalidation: { icon: TriangleAlert, textKey: 'offline.revalidationError', testID: 'status-banner', tone: 'warning' },
  sseReconnect: { icon: CloudOff, textKey: 'offline.serverConnecting', testID: 'status-banner', tone: 'warning' },
  syncError: { icon: TriangleAlert, textKey: 'offline.syncError', testID: 'status-banner', tone: 'warning' },
};

/**
 * The one connection/session status banner ({@link useTopBanners} picks which
 * status). A single {@link Banner} whose content changes, rather than one
 * banner per status: going from one status to another then just swaps the
 * text, instead of fading one banner out while another fades in, which
 * briefly stacked two and let the outgoing one slide under the status bar.
 */
export default function StatusBanner({ status, applyTopInset }: { status: StatusBannerKey | null; applyTopInset: boolean }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // With no status the banner is hidden; Banner keeps showing the last status
  // while it fades out, so the placeholder below is never seen.
  const { icon, textKey, testID, tone } = STATUSES[status ?? 'offline'];
  const offline = tone === 'offline';

  return (
    <Banner
      visible={status !== null}
      applyTopInset={applyTopInset}
      testID={testID}
      icon={icon}
      text={t(textKey)}
      backgroundColor={offline ? colors.offlineBanner : colors.warning}
      borderColor={offline ? colors.offlineBannerBorder : colors.warningBorder}
      textColor={offline ? colors.offlineBannerText : colors.warningText}
    />
  );
}
