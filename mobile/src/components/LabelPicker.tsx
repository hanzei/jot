import { useMemo, useState } from 'react';
import {
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Plus, Square, SquareCheck } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { VALIDATION, canCreateLabelFromQuery, filterLabelsByQuery, type Label } from '@jot/shared';
import { useTheme } from '../theme/ThemeContext';
import { useLabels, useAddLabelToNote, useRemoveLabelFromNote, buildLocalLabel } from '../hooks/useLabels';
import BottomSheet from './BottomSheet';

interface LabelPickerProps {
  visible: boolean;
  /**
   * The note whose labels are edited on the server. Null for a new note that
   * does not exist yet: the picker then edits `noteLabels` locally through
   * `onLocalLabelsChange`, and the note's create request carries the names.
   */
  noteId: string | null;
  noteLabels: Label[];
  onClose: () => void;
  onLabelsChanged?: () => void;
  onLocalLabelsChange?: (labels: Label[]) => void;
}

export default function LabelPicker({
  visible,
  noteId,
  noteLabels,
  onClose,
  onLabelsChanged,
  onLocalLabelsChange,
}: LabelPickerProps) {
  // One field both filters the list and names a new label, as on the webapp.
  const [query, setQuery] = useState('');
  // id of the label row currently being toggled and whether a brand-new label
  // is being created, so the affected row/button can show a spinner instead of
  // silently sitting for up to the ~5s write timeout (#698).
  const [togglingLabelId, setTogglingLabelId] = useState<string | null>(null);
  const [isCreatingLabel, setIsCreatingLabel] = useState(false);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { data: allLabels, isLoading } = useLabels();
  const addLabel = useAddLabelToNote();
  const removeLabel = useRemoveLabelFromNote();

  const noteLabelIds = new Set(noteLabels.map((l) => l.id));
  const isMutating = addLabel.isPending || removeLabel.isPending;
  const trimmedQuery = query.trim();
  // On a not-yet-created note, a label named in the picker exists only as the
  // editor's placeholder, so list it alongside the stored ones to keep it
  // uncheckable and out of the create row.
  const listedLabels = useMemo(() => {
    const stored = allLabels ?? [];
    if (noteId !== null) return stored;
    const storedIds = new Set(stored.map((l) => l.id));
    return [...stored, ...noteLabels.filter((l) => !storedIds.has(l.id))];
  }, [allLabels, noteId, noteLabels]);
  const filteredLabels = useMemo(() => filterLabelsByQuery(listedLabels, trimmedQuery), [listedLabels, trimmedQuery]);
  // Until the label list is loaded we cannot tell whether the query names an
  // existing label, so the create row stays hidden.
  const showCreate = !isLoading && canCreateLabelFromQuery(filteredLabels, trimmedQuery);

  const handleToggleLabel = async (label: Label) => {
    if (isMutating) return;
    if (noteId === null) {
      onLocalLabelsChange?.(noteLabelIds.has(label.id)
        ? noteLabels.filter((l) => l.id !== label.id)
        : [...noteLabels, label]);
      return;
    }
    setTogglingLabelId(label.id);
    try {
      if (noteLabelIds.has(label.id)) {
        await removeLabel.mutateAsync({ noteId, labelId: label.id });
      } else {
        await addLabel.mutateAsync({ noteId, name: label.name });
      }
      onLabelsChanged?.();
    } catch {
      Alert.alert(t('common.error'), t('labels.failedUpdate'));
    } finally {
      setTogglingLabelId(null);
    }
  };

  const handleCreateLabel = async () => {
    if (!showCreate || isMutating) return;
    if (noteId === null) {
      // Only a placeholder for the editor's chips: the create sends the name,
      // and the server (or the offline create) makes the real label.
      onLocalLabelsChange?.([...noteLabels, buildLocalLabel(trimmedQuery, '')]);
      setQuery('');
      return;
    }
    setIsCreatingLabel(true);
    try {
      await addLabel.mutateAsync({ noteId, name: trimmedQuery });
      setQuery('');
      onLabelsChanged?.();
    } catch {
      Alert.alert(t('common.error'), t('labels.failedCreate'));
    } finally {
      setIsCreatingLabel(false);
    }
  };

  // The sheet stays mounted between openings, so clear the search on close
  // rather than reopening on a stale filter.
  const handleClose = () => {
    setQuery('');
    onClose();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={handleClose}
      title={t('labels.title')}
      testID="label-picker"
      maxHeight="70%"
      avoidKeyboard
    >
      <TextInput
        style={[styles.searchInput, { color: colors.text, borderBottomColor: colors.border }]}
        value={query}
        onChangeText={setQuery}
        // maxLength counts UTF-16 units while the server counts code points, so
        // astral input is cut early — accepted, as for PAT names (issue #772).
        maxLength={VALIDATION.LABEL_NAME_MAX_LENGTH}
        placeholder={t('labels.searchPlaceholder')}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={t('labels.searchPlaceholder')}
        // "Done" creates only when the query matches nothing: with
        // partial matches listed, the user more likely meant one of them.
        onSubmitEditing={() => {
          if (filteredLabels.length === 0) void handleCreateLabel();
        }}
        returnKeyType="done"
        testID="label-search-input"
      />

      {isLoading ? (
        <ActivityIndicator style={styles.loader} color={colors.primary} />
      ) : (
        <ScrollView style={styles.labelList} keyboardShouldPersistTaps="handled">
          {filteredLabels.map((label) => (
            <TouchableOpacity
              key={label.id}
              style={[styles.labelRow, isMutating && styles.labelRowDisabled]}
              onPress={() => handleToggleLabel(label)}
              disabled={isMutating}
              testID={`label-item-${label.id}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: noteLabelIds.has(label.id), busy: togglingLabelId === label.id }}
            >
              {togglingLabelId === label.id ? (
                <ActivityIndicator size="small" color={colors.primary} testID={`label-item-${label.id}-spinner`} />
              ) : noteLabelIds.has(label.id) ? (
                <SquareCheck size={22} color={colors.primary} />
              ) : (
                <Square size={22} color={colors.iconMuted} />
              )}
              <Text style={[styles.labelName, { color: colors.text }]}>{label.name}</Text>
            </TouchableOpacity>
          ))}
          {showCreate && (
            <TouchableOpacity
              style={[styles.labelRow, isMutating && !isCreatingLabel && styles.labelRowDisabled]}
              onPress={handleCreateLabel}
              disabled={isMutating}
              testID="label-create-option"
              accessibilityRole="button"
              accessibilityState={{ disabled: isMutating, busy: isCreatingLabel }}
            >
              {isCreatingLabel ? (
                <ActivityIndicator size="small" color={colors.primary} testID="label-create-option-spinner" />
              ) : (
                <Plus size={22} color={colors.primary} />
              )}
              <Text style={[styles.labelName, styles.createLabelText, { color: colors.primary }]} numberOfLines={1}>
                {t('labels.createLabel', { name: trimmedQuery })}
              </Text>
            </TouchableOpacity>
          )}
          {filteredLabels.length === 0 && !showCreate && (
            <Text style={[styles.emptyLabels, { color: colors.textMuted }]}>{t('labels.noLabels')}</Text>
          )}
        </ScrollView>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  loader: {
    marginVertical: 24,
  },
  labelList: {
    maxHeight: 240,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
  labelName: {
    fontSize: 15,
  },
  emptyLabels: {
    fontSize: 14,
    paddingVertical: 12,
    textAlign: 'center',
  },
  searchInput: {
    fontSize: 15,
    paddingVertical: 6,
    borderBottomWidth: 1,
    marginBottom: 8,
  },
  createLabelText: {
    flexShrink: 1,
  },
  labelRowDisabled: {
    opacity: 0.5,
  },
});
