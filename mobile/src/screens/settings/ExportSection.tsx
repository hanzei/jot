import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Sharing from 'expo-sharing';
import { useTheme } from '../../theme/ThemeContext';
import { downloadExportBundle } from '../../api/export';
import { isOnlineWriteAllowed } from '../../api/serverReachability';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { deleteFileIfExists } from '../../utils/fs';
import { styles } from './styles';

export default function ExportSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isConnected } = useNetworkStatus();

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  // There is no queue to fall back on, so the export is only offered while the
  // server is usable (mobile-connectivity-handling.md §4.3).
  const online = isOnlineWriteAllowed(isConnected);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError('');
    let bundleUri: string | null = null;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setExportError('export.shareUnavailable');
        return;
      }
      try {
        bundleUri = await downloadExportBundle();
      } catch {
        // No error detail on purpose: diagnostics logs must not carry the
        // file path, and the message adds nothing the user can act on.
        console.warn('Notes export download failed');
        setExportError('export.exportFailed');
        return;
      }
      // Resolves once the share sheet closes, whichever target was picked.
      await Sharing.shareAsync(bundleUri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: t('export.shareTitle'),
      });
    } catch {
      console.warn('Notes export share failed');
      setExportError('export.shareFailed');
    } finally {
      if (bundleUri) deleteFileIfExists(bundleUri);
      setExporting(false);
    }
  }, [t]);

  const disabled = exporting || !online;

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.exportSection')}</Text>
      <Text style={[styles.sectionDescription, { color: colors.textSecondary }]}>
        {t('export.description')}
      </Text>
      {!online && (
        <Text style={[styles.sectionDescription, { color: colors.textMuted }]} testID="settings-export-offline">
          {t('export.offline')}
        </Text>
      )}
      {exportError !== '' && (
        <Text style={[styles.errorText, { color: colors.error }]} testID="settings-export-error">
          {t(exportError)}
        </Text>
      )}
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.primary }, disabled && styles.buttonDisabled]}
        onPress={handleExport}
        disabled={disabled}
        testID="settings-export-submit"
        accessibilityLabel={t('export.exportButton')}
        accessibilityRole="button"
        accessibilityState={{ disabled, busy: exporting }}
      >
        <Text style={styles.primaryButtonText}>
          {exporting ? t('export.exporting') : t('export.exportButton')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
