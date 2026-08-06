import { CloudOff } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { TopBannerProps } from '../hooks/useTopBanners';
import Banner from './Banner';

/**
 * Shown when the device is online but the SSE connection to the server has
 * been down for more than 2 seconds. Covers both initial cold-start (server
 * unreachable from the beginning) and mid-session disconnections. Visibility
 * and safe-area ownership are decided centrally by {@link useVisibleTopBanners}.
 */
export default function SSEReconnectBanner({ visible, applyTopInset }: TopBannerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Banner
      visible={visible}
      applyTopInset={applyTopInset}
      icon={CloudOff}
      text={t('offline.serverConnecting')}
      backgroundColor={colors.warning}
      borderColor={colors.warningBorder}
      textColor={colors.warningText}
    />
  );
}
