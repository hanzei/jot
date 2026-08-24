import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../theme/ThemeContext';
import { importKeepFile, getNotes } from '../../api/notes';
import { getLabels } from '../../api/labels';
import { saveServerLabels, saveServerNotes } from '../../db/syncQueue';
import {
  labelCountsQueryKey,
  labelsQueryKey,
  noteLocalQueryScopeKey,
  notesLocalQueryScopeKey,
} from '../../hooks/queryKeys';
import { displayMessage, extractApiError } from '../../i18n/utils';
import type { ImportResponse } from '@jot/shared';
import { styles } from './styles';

export default function ImportSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  const [selectedImportFile, setSelectedImportFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);

  const handleSelectImportFile = useCallback(async () => {
    setImportError('');
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/json', 'application/zip', 'application/x-zip-compressed'],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;

    const file = result.assets[0];
    const fileName = file.name.toLowerCase();
    const mimeType = file.mimeType?.toLowerCase() ?? '';
    const isJson = fileName.endsWith('.json') || mimeType === 'application/json';
    const isZip = fileName.endsWith('.zip')
      || mimeType === 'application/zip'
      || mimeType === 'application/x-zip-compressed';

    if (!isJson && !isZip) {
      setSelectedImportFile(null);
      setImportResult(null);
      setImportError('import.invalidFileType');
      return;
    }

    setSelectedImportFile(file);
    setImportResult(null);
    setImportError('');
  }, []);

  const handleImportNotes = useCallback(async () => {
    if (!selectedImportFile) return;
    setImporting(true);
    setImportError('');
    setImportResult(null);
    try {
      const response = await importKeepFile({
        uri: selectedImportFile.uri,
        name: selectedImportFile.name,
        mimeType: selectedImportFile.mimeType,
      });
      setImportResult(response);
      setSelectedImportFile(null);
      try {
        // An import creates labels as well as notes, and every cache below reads
        // local SQLite — so both have to be pulled before the invalidations, or
        // the re-read just re-serves the pre-import rows.
        const [latestNotes, latestLabels] = await Promise.all([getNotes(), getLabels()]);
        await saveServerNotes(db, latestNotes);
        await saveServerLabels(db, latestLabels);
      } catch (syncErr) {
        console.warn('Post-import sync failed:', syncErr);
      } finally {
        queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
        queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
        queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
        // Counts come from the note rows (labels_json), not the labels table.
        queryClient.invalidateQueries({ queryKey: labelCountsQueryKey() });
      }
    } catch (err: unknown) {
      setImportError(extractApiError(err) ?? 'import.importFailed');
    } finally {
      setImporting(false);
    }
  }, [db, queryClient, selectedImportFile]);

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.importSection')}</Text>
      <Text style={[styles.sectionDescription, { color: colors.textSecondary }]}>
        {t('settings.importDescription')}
      </Text>
      <TouchableOpacity
        style={[styles.primaryButton, styles.importSelectButton, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}
        onPress={handleSelectImportFile}
        disabled={importing}
        testID="settings-import-select-file"
        accessibilityLabel={t('settings.importButton')}
        accessibilityRole="button"
      >
        <Text style={[styles.importSelectButtonText, { color: colors.text }]}>
          {t('settings.importButton')}
        </Text>
      </TouchableOpacity>
      <Text style={[styles.importFileTypesText, { color: colors.textMuted }]}>{t('import.fileTypes')}</Text>
      {selectedImportFile && (
        <Text style={[styles.importFileName, { color: colors.text }]} numberOfLines={1}>
          {selectedImportFile.name}
        </Text>
      )}
      {importError !== '' && (
        <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, importError)}</Text>
      )}
      {importResult && (
        <>
          <Text style={[styles.successText, styles.importResultText, { color: colors.success }]}>
            {t('import.importedNotes', { count: importResult.imported })}
            {importResult.skipped > 0 ? ` ${t('import.skipped', { count: importResult.skipped })}` : ''}
            {importResult.errors?.length ? `, ${t('import.failed', { count: importResult.errors.length })}` : ''}.
          </Text>
          {importResult.errors && importResult.errors.length > 0 && (
            <View style={styles.importErrorsContainer}>
              {importResult.errors.map((error, index) => (
                <Text key={`${index}-${error}`} style={[styles.errorText, styles.importErrorItem, { color: colors.error }]}>
                  • {error}
                </Text>
              ))}
            </View>
          )}
        </>
      )}
      <TouchableOpacity
        style={[
          styles.primaryButton,
          { backgroundColor: colors.primary },
          (importing || !selectedImportFile) && styles.buttonDisabled,
        ]}
        onPress={handleImportNotes}
        disabled={importing || !selectedImportFile}
        testID="settings-import-submit"
        accessibilityLabel={t('import.importButton')}
        accessibilityRole="button"
      >
        <Text style={styles.primaryButtonText}>
          {importing ? t('import.importing') : t('import.importButton')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
