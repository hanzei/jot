import React from 'react';
import { View, Text, Modal, Pressable, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { styles } from './styles';

interface CreateLabelModalProps {
  visible: boolean;
  value: string;
  onChange: (text: string) => void;
  isPending: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export default function CreateLabelModal({
  visible,
  value,
  onChange,
  isPending,
  onSubmit,
  onClose,
}: CreateLabelModalProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Modal
      visible={visible}
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
            {t('labels.createInputLabel')}
          </Text>
          <TextInput
            style={[styles.modalInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={value}
            onChangeText={onChange}
            placeholder={t('labels.newLabelPlaceholder')}
            placeholderTextColor={colors.placeholder}
            autoFocus
            editable={!isPending}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            testID="create-label-input"
          />
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalSecondaryButton, { borderColor: colors.border }]}
              onPress={onClose}
              disabled={isPending}
            >
              <Text style={[styles.modalSecondaryText, { color: colors.textSecondary }]}>
                {t('labels.createCancel')}
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
              testID="create-label-submit"
              accessibilityState={{ disabled: !value.trim() || isPending, busy: isPending }}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#fff" testID="create-label-submit-spinner" />
              ) : (
                <Text style={styles.modalPrimaryText}>{t('labels.createSave')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
