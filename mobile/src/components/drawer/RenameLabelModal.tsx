import React from 'react';
import { View, Text, Modal, Pressable, TextInput, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { styles } from './styles';
import type { Label } from '@jot/shared';

interface RenameLabelModalProps {
  target: Label | null;
  value: string;
  onChange: (text: string) => void;
  isPending: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export default function RenameLabelModal({
  target,
  value,
  onChange,
  isPending,
  onSubmit,
  onClose,
}: RenameLabelModalProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      >
        <Pressable
          style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
          onPress={(event) => event.stopPropagation()}
        >
          <Text style={[styles.modalTitle, { color: colors.text }]}>
            {t('labels.renameInputLabel', { name: target?.name ?? '' })}
          </Text>
          <TextInput
            style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={value}
            onChangeText={onChange}
            placeholder={t('labels.renamePlaceholder')}
            placeholderTextColor={colors.placeholder}
            autoFocus
            editable={!isPending}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            testID="rename-label-input"
          />
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
              onPress={onClose}
              disabled={isPending}
            >
              <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                {t('labels.renameCancel')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modalButton,
                { backgroundColor: colors.primary },
                !value.trim() && styles.modalButtonDisabled,
              ]}
              onPress={onSubmit}
              disabled={!value.trim() || isPending}
              testID="rename-label-submit"
            >
              <Text style={styles.modalPrimaryText}>
                {isPending ? t('settings.saving') : t('labels.renameSave')}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
