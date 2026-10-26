import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Sharing from 'expo-sharing';
import { useTheme } from '../../theme/ThemeContext';
import { downloadExportBundle } from '../../api/export';
import { isOnlineWriteAllowed, isServerReachable, subscribeToServerReachability } from '../../api/serverReachability';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { deleteFileIfExists } from '../../utils/fs';
import { styles } from './styles';

export default function ExportSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isConnected } = useNetworkStatus();

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  // Subscribed only to re-render when reachability flips; isOnlineWriteAllowed
  // reads it. There is no queue to fall back on, so the export is only offered
  // while the server is usable (mobile-connectivity-handling.md §4.3).
  useSyncExternalStore(subscribeToServerReachability, isServerReachable);
  const online = isOnlineWriteAllowed(isConnected);

  // Set exactly while an export runs. It guards a second press landing before
  // `exporting` re-renders the button disabled, and is aborted on unmount so
  // leaving Settings (logout, server switch) cancels the download instead of
  // opening a share sheet over whatever screen is shown.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleExport = useCallback(async () => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setExporting(true);
    setExportError('');
    let bundleUri: string | null = null;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setExportError('export.shareUnavailable');
        return;
      }
      bundleUri = await downloadExportBundle(controller.signal);
      if (controller.signal.aborted) {
        deleteFileIfExists(bundleUri);
        return;
      }
      await Sharing.shareAsync(bundleUri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: t('export.shareTitle'),
      });
      // Kept for the receiving app; see EXPORT_BUNDLE_RETENTION_MS.
    } catch {
      if (bundleUri) deleteFileIfExists(bundleUri);
      if (controller.signal.aborted) return;
      // No error detail on purpose: diagnostics logs must not carry the file
      // path. A null bundleUri means the download (not the share) failed.
      if (bundleUri) {
        console.warn('Notes export share failed');
        setExportError('export.shareFailed');
      } else {
        console.warn('Notes export download failed');
        setExportError('export.exportFailed');
      }
    } finally {
      abortRef.current = null;
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
