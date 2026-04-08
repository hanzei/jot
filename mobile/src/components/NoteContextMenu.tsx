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
import { useTranslation } from 'react-i18next';
import type { Note } from '@jot/shared';
import { useTheme } from '../theme/ThemeContext';
import { isLocalId } from '../db/noteQueries';

export type ContextMenuViewContext = 'notes' | 'archived' | 'trash' | 'my-tasks';

interface NoteContextMenuProps {
  visible: boolean;
  note: Note | null;
  viewContext: ContextMenuViewContext;
  onClose: () => void;
  onPin: (note: Note) => void;
  onArchive: (note: Note) => void;
  onUnarchive: (note: Note) => void;
  onDuplicate: (note: Note) => void;
  onMoveToTrash: (note: Note) => void;
  onRestore: (note: Note) => void;
  onDeletePermanently: (note: Note) => void;
  onChangeColor: (note: Note) => void;
  onShare: (note: Note) => void;
  onManageLabels?: (note: Note) => void;
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
  onDuplicate,
  onMoveToTrash,
  onRestore,
  onDeletePermanently,
  onChangeColor,
  onShare,
  onManageLabels,
}: NoteContextMenuProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!note) return null;

  const createLabelAction = (currentNote: Note): Action | null => {
    if (!onManageLabels || isLocalId(currentNote.id)) {
      return null;
    }
    return {
      icon: 'pricetag-outline',
      label: t('labels.title'),
      onPress: () => { onClose(); onManageLabels(currentNote); },
      testId: 'context-label',
    };
  };

  const actions: Action[] = [];

  if (viewContext === 'notes' || viewContext === 'my-tasks') {
    actions.push({
      icon: 'color-palette-outline',
      label: t('note.changeColor'),
      onPress: () => { onClose(); onChangeColor(note); },
      testId: 'context-color',
    });
    // is_shared means the current user is a recipient, not the owner — hide Share for non-owners
    if (!note.is_shared) {
      actions.push({
        icon: 'share-social-outline',
        label: t('note.share'),
        onPress: () => { onClose(); onShare(note); },
        testId: 'context-share',
      });
    }
    actions.push({
      icon: note.pinned ? 'pin' : 'pin-outline',
      label: note.pinned ? t('note.unpin') : t('note.pin'),
      onPress: () => { onClose(); onPin(note); },
      testId: 'context-pin',
    });
    actions.push({
      icon: 'archive-outline',
      label: t('note.archive'),
      onPress: () => { onClose(); onArchive(note); },
      testId: 'context-archive',
    });
    actions.push({
      icon: 'copy-outline',
      label: t('note.duplicate'),
      onPress: () => { onClose(); onDuplicate(note); },
      testId: 'context-duplicate',
    });
    const labelAction = createLabelAction(note);
    if (labelAction) {
      actions.push(labelAction);
    }
    actions.push({
      icon: 'trash-outline',
      label: t('note.moveToTrash'),
      onPress: () => { onClose(); onMoveToTrash(note); },
      destructive: true,
      testId: 'context-trash',
    });
  } else if (viewContext === 'archived') {
    actions.push({
      icon: 'archive-outline',
      label: t('note.unarchive'),
      onPress: () => { onClose(); onUnarchive(note); },
      testId: 'context-unarchive',
    });
    actions.push({
      icon: 'copy-outline',
      label: t('note.duplicate'),
      onPress: () => { onClose(); onDuplicate(note); },
      testId: 'context-duplicate',
    });
    const labelAction = createLabelAction(note);
    if (labelAction) {
      actions.push(labelAction);
    }
    actions.push({
      icon: 'trash-outline',
      label: t('note.moveToTrash'),
      onPress: () => { onClose(); onMoveToTrash(note); },
      destructive: true,
      testId: 'context-trash',
    });
  } else if (viewContext === 'trash') {
    actions.push({
      icon: 'arrow-undo-outline',
      label: t('note.restore'),
      onPress: () => { onClose(); onRestore(note); },
      testId: 'context-restore',
    });
    actions.push({
      icon: 'trash',
      label: t('note.deleteForever'),
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
            {actions.map((action, index) => {
              const isLast = index === actions.length - 1;
              const isDestructive = action.destructive;
              const prevNonDestructive = index > 0 && !actions[index - 1].destructive;
              const nextIsDestructive = actions[index + 1]?.destructive;
              return (
                <React.Fragment key={action.testId}>
                  {isDestructive && prevNonDestructive && (
                    <View style={[styles.destructiveSeparator, { backgroundColor: colors.borderLight }]} />
                  )}
                  <TouchableOpacity
                    style={[
                      styles.actionRow,
                      !isLast && !isDestructive && !nextIsDestructive && { borderBottomColor: colors.borderLight, borderBottomWidth: 1 },
                    ]}
                    onPress={action.onPress}
                    testID={action.testId}
                  >
                    <Ionicons
                      name={action.icon}
                      size={22}
                      color={isDestructive ? colors.error : colors.text}
                    />
                    <Text style={[styles.actionLabel, { color: colors.text }, isDestructive && { color: colors.error }]}>
                      {action.label}
                    </Text>
                  </TouchableOpacity>
                </React.Fragment>
              );
            })}
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
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  handle: {
    width: 40,
    height: 5,
    borderRadius: 2.5,
    alignSelf: 'center',
    marginBottom: 16,
  },
  noteTitle: {
    fontSize: 16,
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
  },
  actionLabel: {
    fontSize: 16,
  },
  destructiveSeparator: {
    height: 1,
    marginVertical: 4,
  },
});
