import React from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { ArrowUpDown, LayoutGrid, List, Menu, Search, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { NOTE_SORT_OPTIONS, type NoteSort } from '@jot/shared';
import { useTheme } from '../../theme/ThemeContext';
import { getNoteSortLabel } from '../../utils/noteSort';
import type { DashboardLayout } from '../../utils/dashboardLayout';
import { styles } from './styles';

interface NotesListHeaderProps {
  variant: 'notes' | 'archived' | 'trash' | 'my-tasks';
  bannerShown: boolean;
  topInset: number;
  searchText: string;
  onSearchChange: (text: string) => void;
  onClearSearch: () => void;
  isSortOpen: boolean;
  onToggleSort: () => void;
  sortMode: NoteSort;
  onSortSelect: (sort: NoteSort) => void;
  sortWarningDismissed: boolean | null;
  onDismissSortWarning: () => void;
  onToggleDrawer: () => void;
  layout: DashboardLayout;
  onToggleLayout: () => void;
}

export default function NotesListHeader({
  variant,
  bannerShown,
  topInset,
  searchText,
  onSearchChange,
  onClearSearch,
  isSortOpen,
  onToggleSort,
  sortMode,
  onSortSelect,
  sortWarningDismissed,
  onDismissSortWarning,
  onToggleDrawer,
  layout,
  onToggleLayout,
}: NotesListHeaderProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const activeSortLabel = getNoteSortLabel(sortMode, t);
  const isGrid = layout === 'grid';
  const LayoutIcon = isGrid ? List : LayoutGrid;

  return (
    <>
      <View
        style={[
          styles.topControlsRow,
          variant === 'notes' ? { paddingTop: bannerShown ? 0 : topInset } : undefined,
        ]}
      >
        {variant === 'notes' && (
          <TouchableOpacity
            style={[styles.menuButton, { backgroundColor: colors.surface, borderColor: colors.searchBorder }]}
            onPress={onToggleDrawer}
            testID="drawer-toggle"
            accessibilityLabel={t('nav.openMenu')}
            accessibilityRole="button"
          >
            <Menu size={22} color={colors.text} />
          </TouchableOpacity>
        )}
        <View style={[styles.searchContainer, { backgroundColor: colors.searchBackground, borderColor: colors.searchBorder }]}>
          <Search size={18} color={colors.iconMuted} style={styles.searchIcon} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={t('dashboard.searchPlaceholder')}
            placeholderTextColor={colors.placeholder}
            accessibilityLabel={t('dashboard.searchPlaceholder')}
            value={searchText}
            onChangeText={onSearchChange}
            returnKeyType="search"
            testID="search-input"
          />
          {searchText.length > 0 && (
            <TouchableOpacity
              onPress={onClearSearch}
              testID="clear-search"
              accessibilityRole="button"
              accessibilityLabel={t('common.clearSearch')}
              hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            >
              <X size={18} color={colors.iconMuted} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          style={[
            styles.sortToggleButton,
            {
              borderColor: colors.searchBorder,
              backgroundColor: colors.surface,
            },
          ]}
          onPress={onToggleLayout}
          testID="layout-toggle"
          accessibilityRole="button"
          accessibilityLabel={t(isGrid ? 'dashboard.layoutToggleToList' : 'dashboard.layoutToggleToGrid')}
          accessibilityState={{ selected: isGrid }}
        >
          <LayoutIcon size={18} color={colors.icon} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.sortToggleButton,
            {
              borderColor: colors.searchBorder,
              backgroundColor: isSortOpen ? colors.primaryLight : colors.surface,
            },
          ]}
          onPress={onToggleSort}
          testID="sort-toggle"
          accessibilityRole="button"
          accessibilityLabel={t('dashboard.sortAccessibilityLabel', { sortLabel: activeSortLabel })}
          accessibilityState={{ expanded: isSortOpen }}
        >
          <ArrowUpDown size={18} color={isSortOpen ? colors.primary : colors.icon} />
        </TouchableOpacity>
      </View>

      {/* Sort preference is global across notes, archived, trash, labels, and my-tasks views. */}
      {isSortOpen && (
        <View style={styles.sortControlsContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.sortControlsContent}
            testID="sort-controls"
          >
            {NOTE_SORT_OPTIONS.map((option) => {
              const isActive = sortMode === option;
              const optionLabel = getNoteSortLabel(option, t);
              return (
                <TouchableOpacity
                  key={option}
                  style={[
                    styles.sortChip,
                    {
                      borderColor: isActive ? colors.primary : colors.border,
                      backgroundColor: isActive ? colors.primaryLight : colors.surface,
                    },
                  ]}
                  onPress={() => onSortSelect(option)}
                  testID={`sort-chip-${option}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('dashboard.sortAccessibilityLabel', { sortLabel: optionLabel })}
                  accessibilityState={{ selected: isActive }}
                >
                  <Text
                    style={[
                      styles.sortChipText,
                      { color: isActive ? colors.primary : colors.textSecondary },
                      isActive && styles.sortChipTextActive,
                    ]}
                  >
                    {optionLabel}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {sortMode !== 'manual' && sortWarningDismissed === false && (
        <View
          style={[
            styles.sortNotice,
            {
              backgroundColor: colors.primaryLight,
              borderColor: colors.primary,
            },
          ]}
          testID="sort-disabled-notice"
        >
          <ArrowUpDown size={16} color={colors.primary} style={styles.sortNoticeIcon} />
          <Text style={[styles.sortNoticeText, { color: colors.textSecondary }]}>
            {t('dashboard.sortDisabledNotice', { sortLabel: activeSortLabel })}
          </Text>
          <TouchableOpacity
            onPress={onDismissSortWarning}
            style={styles.sortNoticeDismiss}
            accessibilityLabel={t('common.close')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={16} color={colors.primary} />
          </TouchableOpacity>
        </View>
      )}
    </>
  );
}
