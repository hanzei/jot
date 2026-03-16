import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  SafeAreaView,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Label } from '@jot/shared';
import { useLabels, useAddLabelToNote, useRemoveLabelFromNote } from '../hooks/useLabels';

interface LabelPickerProps {
  visible: boolean;
  noteId: string;
  noteLabels: Label[];
  onClose: () => void;
  onLabelsChanged?: () => void;
}

export default function LabelPicker({
  visible,
  noteId,
  noteLabels,
  onClose,
  onLabelsChanged,
}: LabelPickerProps) {
  const [newLabelText, setNewLabelText] = useState('');
  const { data: allLabels, isLoading } = useLabels();
  const addLabel = useAddLabelToNote();
  const removeLabel = useRemoveLabelFromNote();

  const noteLabelIds = new Set(noteLabels.map((l) => l.id));
  const isMutating = addLabel.isPending || removeLabel.isPending;

  const handleToggleLabel = async (label: Label) => {
    if (isMutating) return;
    try {
      if (noteLabelIds.has(label.id)) {
        await removeLabel.mutateAsync({ noteId, labelId: label.id });
      } else {
        await addLabel.mutateAsync({ noteId, name: label.name });
      }
      onLabelsChanged?.();
    } catch {
      Alert.alert('Error', 'Failed to update label');
    }
  };

  const handleAddNewLabel = async () => {
    const name = newLabelText.trim();
    if (!name || isMutating) return;
    try {
      await addLabel.mutateAsync({ noteId, name });
      setNewLabelText('');
      onLabelsChanged?.();
    } catch {
      Alert.alert('Error', 'Failed to create label');
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <SafeAreaView style={styles.sheet}>
          <Pressable>
            <View style={styles.handle} />
            <Text style={styles.title}>Labels</Text>

            {isLoading ? (
              <ActivityIndicator style={styles.loader} color="#2563eb" />
            ) : (
              <ScrollView style={styles.labelList} keyboardShouldPersistTaps="handled">
                {(allLabels ?? []).map((label) => (
                  <TouchableOpacity
                    key={label.id}
                    style={[styles.labelRow, isMutating && styles.labelRowDisabled]}
                    onPress={() => handleToggleLabel(label)}
                    disabled={isMutating}
                    testID={`label-item-${label.id}`}
                  >
                    <Ionicons
                      name={noteLabelIds.has(label.id) ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={noteLabelIds.has(label.id) ? '#2563eb' : '#999'}
                    />
                    <Text style={styles.labelName}>{label.name}</Text>
                  </TouchableOpacity>
                ))}
                {(allLabels ?? []).length === 0 && (
                  <Text style={styles.emptyLabels}>No labels yet</Text>
                )}
              </ScrollView>
            )}

            <View style={styles.addRow}>
              <TextInput
                style={styles.addInput}
                value={newLabelText}
                onChangeText={setNewLabelText}
                placeholder="New label"
                placeholderTextColor="#999"
                onSubmitEditing={handleAddNewLabel}
                returnKeyType="done"
                testID="new-label-input"
              />
              <TouchableOpacity
                style={[styles.addBtn, !newLabelText.trim() && styles.addBtnDisabled]}
                onPress={handleAddNewLabel}
                disabled={!newLabelText.trim()}
                testID="add-label-btn"
              >
                <Ionicons
                  name="add"
                  size={22}
                  color={newLabelText.trim() ? '#2563eb' : '#ccc'}
                />
              </TouchableOpacity>
            </View>
          </Pressable>
        </SafeAreaView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '70%',
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: '#d1d5db',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 12,
  },
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
    color: '#1a1a1a',
  },
  emptyLabels: {
    fontSize: 14,
    color: '#999',
    paddingVertical: 12,
    textAlign: 'center',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    marginTop: 8,
    paddingTop: 12,
    gap: 8,
  },
  addInput: {
    flex: 1,
    fontSize: 15,
    color: '#1a1a1a',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  addBtn: {
    padding: 4,
  },
  addBtnDisabled: {
    opacity: 0.5,
  },
  labelRowDisabled: {
    opacity: 0.5,
  },
});
