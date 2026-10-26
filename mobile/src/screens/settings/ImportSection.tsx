import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../theme/ThemeContext';
import { importFile, getNotes } from '../../api/notes';
import { getLabels } from '../../api/labels';
import { saveServerLabels, saveServerNotes } from '../../db/syncQueue';
import {
  labelCountsQueryKey,
  labelsQueryKey,
  noteLocalQueryScopeKey,
  notesLocalQueryScopeKey,
} from '../../hooks/queryKeys';
import { displayMessage, extractApiError } from '../../i18n/utils';
import type { FileImportType, ImportResponse } from '@jot/shared';
import { styles } from './styles';

const ZIP_MIME_TYPES = ['application/zip', 'application/x-zip-compressed'];

// A Jot backup is always a .zip bundle; a Keep export is a Takeout .zip or a
// single note's .json.
const ACCEPTED_MIME_TYPES: Record<FileImportType, string[]> = {
  google_keep: ['application/json', ...ZIP_MIME_TYPES],
  jot_json: ZIP_MIME_TYPES,
};

const FORMAT_OPTIONS: { value: FileImportType; labelKey: string }[] = [
  { value: 'google_keep', labelKey: 'import.formatGoogleKeep' },
  { value: 'jot_json', labelKey: 'import.formatJot' },
];

export default function ImportSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  const [importType, setImportType] = useState<FileImportType>('google_keep');
  const [selectedImportFile, setSelectedImportFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);

  const handleFormatChange = useCallback((type: FileImportType) => {
    setImportType(type);
    setSelectedImportFile(null);
    setImportResult(null);
    setImportError('');
  }, []);

  const handleSelectImportFile = useCallback(async () => {
    setImportError('');
    const result = await DocumentPicker.getDocumentAsync({
      type: ACCEPTED_MIME_TYPES[importType],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;

    const file = result.assets[0];
    const fileName = file.name.toLowerCase();
    const mimeType = file.mimeType?.toLowerCase() ?? '';
    const isJson = fileName.endsWith('.json') || mimeType === 'application/json';
    const isZip = fileName.endsWith('.zip') || ZIP_MIME_TYPES.includes(mimeType);
    const isValid = importType === 'jot_json' ? isZip : isJson || isZip;

    if (!isValid) {
      setSelectedImportFile(null);
      setImportResult(null);
      setImportError(importType === 'jot_json' ? 'import.invalidFileTypeJot' : 'import.invalidFileType');
      return;
    }

    setSelectedImportFile(file);
    setImportResult(null);
    setImportError('');
  }, [importType]);

  const handleImportNotes = useCallback(async () => {
    if (!selectedImportFile) return;
    setImporting(true);
    setImportError('');
    setImportResult(null);
    try {
      const response = await importFile({
        uri: selectedImportFile.uri,
        name: selectedImportFile.name,
        mimeType: selectedImportFile.mimeType,
      }, importType);
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
  }, [db, importType, queryClient, selectedImportFile]);

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.importSection')}</Text>
      <Text style={[styles.importFormatLabel, { color: colors.text }]}>{t('import.formatLabel')}</Text>
      <View style={styles.importFormatRow} accessibilityRole="radiogroup">
        {FORMAT_OPTIONS.map(option => {
          const isSelected = importType === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.importFormatOption,
                { borderColor: isSelected ? colors.primary : colors.border },
                isSelected && { backgroundColor: colors.primary },
              ]}
              onPress={() => handleFormatChange(option.value)}
              disabled={importing}
              testID={`settings-import-format-${option.value}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected, disabled: importing }}
            >
              <Text style={[styles.importFormatOptionText, { color: isSelected ? '#fff' : colors.text }]}>
                {t(option.labelKey)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[styles.sectionDescription, { color: colors.textSecondary }]}>
        {t(importType === 'jot_json' ? 'import.descriptionJot' : 'import.description')}
      </Text>
      <TouchableOpacity
        style={[styles.primaryButton, styles.importSelectButton, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}
        onPress={handleSelectImportFile}
        disabled={importing}
        testID="settings-import-select-file"
        accessibilityLabel={t('import.selectFile')}
        accessibilityRole="button"
      >
        <Text style={[styles.importSelectButtonText, { color: colors.text }]}>
          {t('import.selectFile')}
        </Text>
      </TouchableOpacity>
      <Text style={[styles.importFileTypesText, { color: colors.textMuted }]}>
        {t(importType === 'jot_json' ? 'import.fileTypesJot' : 'import.fileTypes')}
      </Text>
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
