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

  // Subscribed so the button re-enables (or disables) as soon as the
  // reachability belief flips, rather than on the next unrelated re-render.
  const serverReachable = useSyncExternalStore(subscribeToServerReachability, isServerReachable);
  // There is no queue to fall back on, so the export is only offered while the
  // server is usable (mobile-connectivity-handling.md §4.3).
  const online = serverReachable && isOnlineWriteAllowed(isConnected);

  // Guards against a second press landing before `exporting` re-renders the
  // button disabled: a second export would clear the first one's bundle and
  // run the expensive server export twice.
  const inFlight = useRef(false);
  // Aborted on unmount, so leaving Settings (logout, server switch) cancels the
  // download instead of opening a share sheet over whatever screen is shown.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleExport = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
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
      try {
        bundleUri = await downloadExportBundle(controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        // No error detail on purpose: diagnostics logs must not carry the
        // file path, and the message adds nothing the user can act on.
        console.warn('Notes export download failed');
        setExportError('export.exportFailed');
        return;
      }
      if (controller.signal.aborted) {
        deleteFileIfExists(bundleUri);
        return;
      }
      await Sharing.shareAsync(bundleUri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: t('export.shareTitle'),
      });
      // Deliberately not deleted here. On Android shareAsync resolves when the
      // chooser returns, which can be before the picked app (Drive uploading in
      // the background, a messenger in its own task) has finished reading the
      // file, and deleting it then silently breaks the backup. The next export
      // clears it (clearExportCache), and the OS may purge the cache before that.
    } catch {
      console.warn('Notes export share failed');
      setExportError('export.shareFailed');
      if (bundleUri) deleteFileIfExists(bundleUri);
    } finally {
      inFlight.current = false;
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
