import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Pressable,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Note } from '@jot/shared';
import { useTheme } from '../theme/ThemeContext';

export type ContextMenuViewContext = 'notes' | 'archived' | 'trash' | 'my-todo';

interface NoteContextMenuProps {
  visible: boolean;
  note: Note | null;
  viewContext: ContextMenuViewContext;
  onClose: () => void;
  onPin: (note: Note) => void;
  onArchive: (note: Note) => void;
  onUnarchive: (note: Note) => void;
  onMoveToTrash: (note: Note) => void;
  onRestore: (note: Note) => void;
  onDeletePermanently: (note: Note) => void;
  onChangeColor: (note: Note) => void;
  onShare: (note: Note) => void;
}

interface Action {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  testId: string;
}

export default function NoteContextMenu({
  visible,
  note,
  viewContext,
  onClose,
  onPin,
  onArchive,
  onUnarchive,
  onMoveToTrash,
  onRestore,
  onDeletePermanently,
  onChangeColor,
  onShare,
}: NoteContextMenuProps) {
  const { colors } = useTheme();

  if (!note) return null;

  const actions: Action[] = [];

  if (viewContext === 'notes' || viewContext === 'my-todo') {
    actions.push({
      icon: 'color-palette-outline',
      label: 'Change color',
      onPress: () => { onClose(); onChangeColor(note); },
      testId: 'context-color',
    });
    // is_shared means the current user is a recipient, not the owner — hide Share for non-owners
    if (!note.is_shared) {
      actions.push({
        icon: 'share-social-outline',
        label: 'Share',
        onPress: () => { onClose(); onShare(note); },
        testId: 'context-share',
      });
    }
    actions.push({
      icon: note.pinned ? 'pin' : 'pin-outline',
      label: note.pinned ? 'Unpin' : 'Pin',
      onPress: () => { onClose(); onPin(note); },
      testId: 'context-pin',
    });
    actions.push({
      icon: 'archive-outline',
      label: 'Archive',
      onPress: () => { onClose(); onArchive(note); },
      testId: 'context-archive',
    });
    actions.push({
      icon: 'trash-outline',
      label: 'Move to trash',
      onPress: () => { onClose(); onMoveToTrash(note); },
      destructive: true,
      testId: 'context-trash',
    });
  } else if (viewContext === 'archived') {
    actions.push({
      icon: 'archive-outline',
      label: 'Unarchive',
      onPress: () => { onClose(); onUnarchive(note); },
      testId: 'context-unarchive',
    });
    actions.push({
      icon: 'trash-outline',
      label: 'Move to trash',
      onPress: () => { onClose(); onMoveToTrash(note); },
      destructive: true,
      testId: 'context-trash',
    });
  } else if (viewContext === 'trash') {
    actions.push({
      icon: 'arrow-undo-outline',
      label: 'Restore',
      onPress: () => { onClose(); onRestore(note); },
      testId: 'context-restore',
    });
    actions.push({
      icon: 'trash',
      label: 'Delete permanently',
      onPress: () => { onClose(); onDeletePermanently(note); },
      destructive: true,
      testId: 'context-delete-permanently',
    });
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay }]} onPress={onClose}>
        <SafeAreaView style={[styles.sheet, { backgroundColor: colors.sheetBackground }]}>
          <Pressable>
            <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
            {note.title ? (
              <Text style={[styles.noteTitle, { color: colors.text, borderBottomColor: colors.borderLight }]} numberOfLines={1}>
                {note.title}
              </Text>
            ) : null}
            {actions.map((action) => (
              <TouchableOpacity
                key={action.testId}
                style={[styles.actionRow, { borderBottomColor: colors.borderLight }]}
                onPress={action.onPress}
                testID={action.testId}
              >
                <Ionicons
                  name={action.icon}
                  size={22}
                  color={action.destructive ? colors.error : colors.text}
                />
                <Text style={[styles.actionLabel, { color: colors.text }, action.destructive && { color: colors.error }]}>
                  {action.label}
                </Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </SafeAreaView>
      </Pressable>
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
    padding: 16,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  noteTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 14,
    borderBottomWidth: 1,
  },
  actionLabel: {
    fontSize: 16,
  },
});
