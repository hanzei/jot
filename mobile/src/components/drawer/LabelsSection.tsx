import React, { useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { EllipsisVertical, Plus, Tag } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { styles } from './styles';
import type { Label } from '@jot/shared';

interface LabelsSectionProps {
  labels: Label[];
  labelCounts: Record<string, number> | undefined;
  activeLabelId: string | undefined;
  onLabelNavigate: (labelId: string, labelName: string) => void;
  onOpenRenameModal: (label: Label) => void;
  onDeleteLabel: (label: Label) => void;
  onCreateLabelPress: () => void;
  /** id of the label currently being deleted, so its row can show a spinner
      instead of sitting with no feedback for the ~5s write timeout (#698). */
  deletingLabelId: string | null;
}

export default function LabelsSection({
  labels,
  labelCounts,
  activeLabelId,
  onLabelNavigate,
  onOpenRenameModal,
  onDeleteLabel,
  onCreateLabelPress,
  deletingLabelId,
}: LabelsSectionProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const longPressHandledRef = useRef(false);

  const openLabelMenu = useCallback((label: Label) => {
    Alert.alert(label.name, t('labels.menuOptions', { name: label.name }), [
      {
        text: t('labels.rename'),
        onPress: () => {
          longPressHandledRef.current = false;
          onOpenRenameModal(label);
        },
      },
      {
        text: t('labels.delete'),
        style: 'destructive',
        onPress: () => {
          longPressHandledRef.current = false;
          onDeleteLabel(label);
        },
      },
      { text: t('common.cancel'), style: 'cancel', onPress: () => { longPressHandledRef.current = false; } },
    ], { cancelable: true, onDismiss: () => { longPressHandledRef.current = false; } });
  }, [onDeleteLabel, onOpenRenameModal, t]);

  const handleLabelPress = useCallback((labelId: string, labelName: string) => {
    if (longPressHandledRef.current) {
      longPressHandledRef.current = false;
      return;
    }
    onLabelNavigate(labelId, labelName);
  }, [onLabelNavigate]);

  const handleLabelLongPress = useCallback((label: Label) => {
    longPressHandledRef.current = true;
    openLabelMenu(label);
  }, [openLabelMenu]);

  return (
    <>
      {labels.length > 0 && (
        <>
          <View style={[styles.navDivider, { backgroundColor: colors.divider }]} />
          {labels.map((label) => {
            const isActive = activeLabelId === label.id;
            const isDeleting = deletingLabelId === label.id;
            const labelCount = labelCounts?.[label.id] ?? 0;
            const labelAccessibilityName = `${label.name}, ${labelCount}`;
            return (
              <View
                key={label.id}
                style={[styles.labelRow, isActive && { backgroundColor: colors.primaryLight }]}
              >
                <TouchableOpacity
                  style={[styles.navItem, styles.labelNavItem]}
                  onPress={() => handleLabelPress(label.id, label.name)}
                  onLongPress={() => handleLabelLongPress(label)}
                  delayLongPress={250}
                  disabled={isDeleting}
                  testID={`drawer-label-${label.id}`}
                  accessibilityLabel={labelAccessibilityName}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive, disabled: isDeleting }}
                >
                  <Tag
                    size={22}
                    color={isActive ? colors.primary : colors.icon}
                    fill={isActive ? colors.primary : 'none'}
                  />
                  <Text
                    style={[styles.navItemText, { color: colors.icon }, isActive && { color: colors.primary, fontWeight: '600' }]}
                    numberOfLines={1}
                  >
                    {label.name}
                  </Text>
                </TouchableOpacity>
                <Text
                  style={[styles.labelCount, { color: isActive ? colors.primary : colors.textSecondary }]}
                  testID={`drawer-label-count-${label.id}`}
                >
                  {labelCount}
                </Text>
                {isDeleting ? (
                  <View style={styles.labelMenuButton} testID={`drawer-label-deleting-${label.id}`}>
                    <ActivityIndicator size="small" color={isActive ? colors.primary : colors.icon} />
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.labelMenuButton}
                    onPress={() => openLabelMenu(label)}
                    hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`${label.name}. ${t('labels.menuOptions', { name: label.name })}`}
                    testID={`drawer-label-menu-${label.id}`}
                  >
                    <EllipsisVertical
                      size={18}
                      color={isActive ? colors.primary : colors.icon}
                    />
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </>
      )}

      <TouchableOpacity
        style={styles.navItem}
        onPress={onCreateLabelPress}
        testID="drawer-label-create"
        accessibilityRole="button"
        accessibilityLabel={t('labels.newSidebar')}
      >
        <Plus size={22} color={colors.primary} />
        <Text style={[styles.navItemText, { color: colors.primary, fontWeight: '600' }]}>
          {t('labels.newSidebar')}
        </Text>
      </TouchableOpacity>
    </>
  );
}
