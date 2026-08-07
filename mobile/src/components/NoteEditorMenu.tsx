import React, { useContext } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { ArrowLeftRight, Copy, Share2, Square, Tag, Trash2, Undo2, UserPlus, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { NoteType } from '@jot/shared';

interface NoteEditorMenuProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Trashed notes open read-only: the overflow menu offers only Restore and
   * Delete-forever, matching the (now-removed) dashboard trash context menu.
   */
  trashed?: boolean;
  /** Optional note title, shown as a header (list notes only, like the card menu). */
  title?: string;
  /** The note's current type, used only to label the convert action below. */
  noteType?: NoteType;
  // Editable-note actions. Callbacks left undefined are hidden based on the
  // editor's current ownership/state.
  onSend?: () => void;
  onShare?: () => void;
  onDuplicate?: () => void;
  onConvert?: () => void;
  onManageLabels?: () => void;
  /** Shown only when the list has completed items (list notes only). */
  onUncheckAllItems?: () => void;
  onDeleteCheckedItems?: () => void;
  onMoveToTrash?: () => void;
  // Trashed-note actions.
  onRestore?: () => void;
  onDeletePermanently?: () => void;
}

interface Action {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  testId: string;
}

/**
 * Bottom-sheet overflow menu for the note editor. Carries the per-note actions
 * that used to live on the editor's action bar (and the dashboard's since-removed
 * card menu), driven by the editor's own callbacks/state rather than a full Note
 * object.
 */
export default function NoteEditorMenu({
  visible,
  onClose,
  trashed = false,
  title,
  noteType,
  onSend,
  onShare,
  onDuplicate,
  onConvert,
  onManageLabels,
  onUncheckAllItems,
  onDeleteCheckedItems,
  onMoveToTrash,
  onRestore,
  onDeletePermanently,
}: NoteEditorMenuProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };

  // Wrap every action so the sheet closes before the action runs, matching the
  // dashboard menu's behavior.
  const run = (fn?: () => void) => () => { onClose(); fn?.(); };

  const actions: Action[] = [];

  if (trashed) {
    if (onRestore) {
      actions.push({
        icon: Undo2,
        label: t('note.restore'),
        onPress: run(onRestore),
        testId: 'editor-menu-restore',
      });
    }
    if (onDeletePermanently) {
      actions.push({
        icon: Trash2,
        label: t('note.deleteForever'),
        onPress: run(onDeletePermanently),
        destructive: true,
        testId: 'editor-menu-delete-permanently',
      });
    }
  } else {
    if (onSend) {
      actions.push({
        icon: Share2,
        label: t('note.send'),
        onPress: run(onSend),
        testId: 'editor-menu-send',
      });
    }
    if (onShare) {
      actions.push({
        icon: UserPlus,
        label: t('note.share'),
        onPress: run(onShare),
        testId: 'editor-menu-share',
      });
    }
    if (onDuplicate) {
      actions.push({
        icon: Copy,
        label: t('note.duplicate'),
        onPress: run(onDuplicate),
        testId: 'editor-menu-duplicate',
      });
    }
    if (onConvert) {
      actions.push({
        icon: ArrowLeftRight,
        label: noteType === 'list' ? t('note.convertToText') : t('note.convertToList'),
        onPress: run(onConvert),
        testId: 'editor-menu-convert',
      });
    }
    if (onManageLabels) {
      actions.push({
        icon: Tag,
        label: t('labels.title'),
        onPress: run(onManageLabels),
        testId: 'editor-menu-label',
      });
    }
    if (onUncheckAllItems) {
      actions.push({
        icon: Square,
        label: t('note.uncheckAllItems'),
        onPress: run(onUncheckAllItems),
        testId: 'editor-menu-uncheck-all',
      });
    }
    if (onDeleteCheckedItems) {
      actions.push({
        icon: Trash2,
        label: t('note.deleteCheckedItems'),
        onPress: run(onDeleteCheckedItems),
        destructive: true,
        testId: 'editor-menu-delete-checked',
      });
    }
    if (onMoveToTrash) {
      actions.push({
        icon: Trash2,
        label: t('note.moveToTrash'),
        onPress: run(onMoveToTrash),
        destructive: true,
        testId: 'editor-menu-trash',
      });
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay }]} onPress={onClose}>
        <View style={[styles.sheet, { backgroundColor: colors.sheetBackground, paddingBottom: insets.bottom || 8 }]}>
          <Pressable>
            <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
            {title ? (
              <Text style={[styles.noteTitle, { color: colors.text, borderBottomColor: colors.borderLight }]} numberOfLines={1}>
                {title}
              </Text>
            ) : null}
            {actions.map((action, index) => {
              const isLast = index === actions.length - 1;
              const isDestructive = action.destructive;
              const prevNonDestructive = index > 0 && !actions[index - 1]!.destructive;
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
                    accessibilityRole="menuitem"
                    accessibilityLabel={action.label}
                  >
                    <action.icon
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
        </View>
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
