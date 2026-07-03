import React from 'react';
import { View, Text, TouchableOpacity, type TextInputProps, type TextInput as TextInputType } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import type { Collaborator } from '@jot/shared';
import { useTheme } from '../../theme/ThemeContext';
import ListItem from '../../components/ListItem';
import { styles } from './styles';
import type { LocalItem } from './listItemModel';

/**
 * Per-item callbacks shared by the active list and the completed-items section.
 * Index-based callbacks receive the item's index in the full `items` array; the
 * id-based ones receive the item id directly.
 */
export interface ListItemHandlers {
  onToggle: (itemId: string, completed: boolean) => void;
  onChangeText: (index: number, text: string) => void;
  onDelete: (index: number) => void;
  onEnterAtCursor: (index: number, cursorPosition: number) => void;
  onBackspaceOnEmpty: (index: number) => void;
  onAssignPress: (itemId: string) => void;
  onFocus: (itemId: string, event: Parameters<NonNullable<TextInputProps['onFocus']>>[0]) => void;
}

interface CheckedItemsSectionProps {
  checkedItems: LocalItem[];
  items: LocalItem[];
  itemIndexMap: Map<string, number>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  getItemRef: (id: string) => React.RefObject<TextInputType | null>;
  isNoteShared: boolean;
  collaborators: Collaborator[];
  hasNoteColor: boolean;
  dividerColor: string;
  handlers: ListItemHandlers;
  /** Id of the item the user just checked off, so only that row pops on mount. */
  popItemId: string | null;
}

/**
 * Renders the collapsible "completed items" section. Completed children whose
 * parent is still unchecked are grouped under a non-interactive "ghost" parent
 * row so the hierarchy stays readable.
 */
export default function CheckedItemsSection({
  checkedItems,
  items,
  itemIndexMap,
  collapsed,
  onToggleCollapsed,
  getItemRef,
  isNoteShared,
  collaborators,
  hasNoteColor,
  dividerColor,
  handlers,
  popItemId,
}: CheckedItemsSectionProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  if (checkedItems.length === 0) return null;

  const renderRows = () => {
    const completedIds = new Set(checkedItems.map((i) => i.id));
    const itemsById = new Map(items.map((i) => [i.id, i]));
    const rows: React.ReactElement[] = [];
    let lastGhostParentId: string | null = null;

    checkedItems.forEach((item) => {
      const originalIndex = itemIndexMap.get(item.id);
      if (originalIndex === undefined) return;
      const parent = item.parentId ? itemsById.get(item.parentId) : undefined;
      const parentIsCompleted = item.parentId ? completedIds.has(item.parentId) : false;

      if (parent && !parentIsCompleted) {
        if (lastGhostParentId !== parent.id) {
          lastGhostParentId = parent.id;
          rows.push(
            <View
              key={`ghost-${parent.id}`}
              style={styles.ghostParent}
              accessibilityLabel={t('note.completedItemGroup', { title: parent.text })}
            >
              <View style={styles.ghostCheckbox} />
              <Text style={[styles.ghostParentText, { color: hasNoteColor ? '#888' : colors.textMuted }]} numberOfLines={1}>
                {parent.text}
              </Text>
            </View>,
          );
        }
      } else {
        lastGhostParentId = null;
      }

      rows.push(
        <ListItem
          key={item.id}
          inputRef={getItemRef(item.id)}
          text={item.text}
          completed={item.completed}
          isActive={false}
          indentLevel={item.parentId ? 1 : 0}
          assignedTo={item.assigned_to}
          isShared={!!isNoteShared}
          collaborators={collaborators}
          hasNoteColor={hasNoteColor}
          popOnMount={item.id === popItemId}
          onToggle={() => { handlers.onToggle(item.id, !item.completed); }}
          onChangeText={(text) => handlers.onChangeText(originalIndex, text)}
          onDelete={() => handlers.onDelete(originalIndex)}
          onSubmitEditing={(cursorPos) => handlers.onEnterAtCursor(originalIndex, cursorPos)}
          onBackspaceOnEmpty={() => handlers.onBackspaceOnEmpty(originalIndex)}
          onAssignPress={() => handlers.onAssignPress(item.id)}
          onFocus={(event) => handlers.onFocus(item.id, event)}
        />,
      );
    });

    return rows;
  };

  return (
    <View style={[styles.checkedSection, { borderTopColor: dividerColor }]} testID="checked-items-section">
      <TouchableOpacity
        style={styles.checkedHeader}
        onPress={onToggleCollapsed}
        testID="toggle-checked-items"
      >
        <Ionicons
          name={collapsed ? 'chevron-forward' : 'chevron-down'}
          size={18}
          color={hasNoteColor ? '#444' : colors.icon}
        />
        <Text style={[styles.checkedHeaderText, { color: hasNoteColor ? '#666' : colors.textSecondary }]}>
          {t('note.completedItems', { count: checkedItems.length })}
        </Text>
      </TouchableOpacity>

      {!collapsed && renderRows()}
    </View>
  );
}
