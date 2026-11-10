import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { DEFAULT_TRASH_RETENTION_DAYS } from '@jot/shared';
import { useServerConfig } from '../../hooks/useServerConfig';

// The trash banner's text: how long the server keeps trashed notes. Its own
// component so only the trash view subscribes to the server config.
export default function TrashBinInfo({ style }: { style: StyleProp<TextStyle> }) {
  const { t } = useTranslation();
  const { trash_retention_days: days = DEFAULT_TRASH_RETENTION_DAYS } = useServerConfig();
  // A retention of 0 (no automatic purge) resolves to the `binInfo_zero` text.
  return <Text style={style}>{t('dashboard.binInfo', { count: days })}</Text>;
}
