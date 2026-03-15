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
import UserAvatar from './UserAvatar';
import { Collaborator, displayName } from '../utils/collaborators';

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
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="assignee-picker-modal"
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={styles.sheet} onStartShouldSetResponder={() => true}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Assign item</Text>
            <TouchableOpacity
              onPress={onClose}
              testID="assignee-picker-close"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={22} color="#666" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} bounces={false}>
            {collaborators.map((c) => {
              const isSelected = c.userId === currentAssigneeId;
              return (
                <TouchableOpacity
                  key={c.userId}
                  style={[styles.row, isSelected && styles.rowSelected]}
                  onPress={() => {
                    onAssign(isSelected ? '' : c.userId);
                    onClose();
                  }}
                  testID={`assignee-option-${c.userId}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Assign to ${displayName(c)}`}
                  accessibilityState={{ selected: isSelected }}
                >
                  <UserAvatar
                    userId={c.userId}
                    username={c.username}
                    hasProfileIcon={c.hasProfileIcon}
                    size="small"
                  />
                  <Text style={styles.rowText} numberOfLines={1}>
                    {displayName(c)}
                  </Text>
                  {isSelected && (
                    <Ionicons name="checkmark" size={20} color="#2563eb" />
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {currentAssigneeId !== '' && (
            <View style={styles.unassignSection}>
              <TouchableOpacity
                style={styles.unassignRow}
                onPress={() => {
                  onAssign('');
                  onClose();
                }}
                testID="assignee-unassign"
                accessibilityRole="button"
                accessibilityLabel="Unassign item"
                accessibilityState={{ selected: false }}
              >
                <View style={styles.unassignIcon}>
                  <Ionicons name="person-remove-outline" size={16} color="#ef4444" />
                </View>
                <Text style={styles.unassignText}>Unassign</Text>
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
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
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
    borderBottomColor: '#f3f4f6',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
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
    borderBottomColor: '#f9fafb',
  },
  rowSelected: {
    backgroundColor: '#eff6ff',
  },
  rowText: {
    flex: 1,
    fontSize: 15,
    color: '#1a1a1a',
  },
  unassignSection: {
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
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
    color: '#ef4444',
  },
});
