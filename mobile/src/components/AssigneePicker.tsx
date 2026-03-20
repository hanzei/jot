import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  ScrollView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import UserAvatar from './UserAvatar';
import { useTheme } from '../theme/ThemeContext';
import { displayName, type Collaborator } from '@jot/shared';

interface AssigneePickerProps {
  visible: boolean;
  collaborators: Collaborator[];
  currentAssigneeId: string;
  onAssign: (userId: string) => void;
  onClose: () => void;
}

export default function AssigneePicker({
  visible,
  collaborators,
  currentAssigneeId,
  onAssign,
  onClose,
}: AssigneePickerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="assignee-picker-modal"
    >
      <TouchableOpacity
        style={[styles.overlay, { backgroundColor: colors.overlay }]}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={[styles.sheet, { backgroundColor: colors.sheetBackground }]} onStartShouldSetResponder={() => true}>
          <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('note.assignItem')}</Text>
            <TouchableOpacity
              onPress={onClose}
              testID="assignee-picker-close"
              accessibilityLabel={t('common.close')}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} bounces={false}>
            {collaborators.map((c) => {
              const isSelected = c.userId === currentAssigneeId;
              return (
                <TouchableOpacity
                  key={c.userId}
                  style={[styles.row, { borderBottomColor: colors.borderLight }, isSelected && { backgroundColor: colors.primaryLight }]}
                  onPress={() => {
                    onAssign(isSelected ? '' : c.userId);
                    onClose();
                  }}
                  testID={`assignee-option-${c.userId}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('note.assignedTo', { name: displayName(c) })}
                  accessibilityState={{ selected: isSelected }}
                >
                  <UserAvatar
                    userId={c.userId}
                    username={c.username}
                    hasProfileIcon={c.hasProfileIcon}
                    size="small"
                  />
                  <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={1}>
                    {displayName(c)}
                  </Text>
                  {isSelected && (
                    <Ionicons name="checkmark" size={20} color={colors.primary} />
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {currentAssigneeId !== '' && (
            <View style={[styles.unassignSection, { borderTopColor: colors.borderLight }]}>
              <TouchableOpacity
                style={styles.unassignRow}
                onPress={() => {
                  onAssign('');
                  onClose();
                }}
                testID="assignee-unassign"
                accessibilityRole="button"
                accessibilityLabel={t('note.unassign')}
                accessibilityState={{ selected: false }}
              >
                <View style={styles.unassignIcon}>
                  <Ionicons name="person-remove-outline" size={16} color={colors.error} />
                </View>
                <Text style={[styles.unassignText, { color: colors.error }]}>{t('note.unassign')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
    maxHeight: '60%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  list: {
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
  },
  rowText: {
    flex: 1,
    fontSize: 15,
  },
  unassignSection: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  unassignRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  unassignIcon: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  unassignText: {
    fontSize: 15,
  },
});
