import { View, Text, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { Archive, ArrowUpDown, Clipboard, LayoutGrid, List, Menu, Search, Tag, Trash2, X, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { NOTE_SORT_OPTIONS, type NoteSort } from '@jot/shared';
import { useTheme } from '../../theme/ThemeContext';
import { getNoteSortLabel } from '../../utils/noteSort';
import type { DashboardLayout } from '../../utils/dashboardLayout';
import { styles } from './styles';

interface NotesListHeaderProps {
  variant: 'notes' | 'archived' | 'trash' | 'my-tasks';
  /** Top safe-area inset still to be applied by content (0 while a banner owns it). */
  topInset: number;
  /** Name of the label the notes view is filtered to, if any. */
  labelName?: string | undefined;
  onClearLabel: () => void;
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
  topInset,
  labelName,
  onClearLabel,
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

  // A "destination" view (archive/bin/my-tasks) shows an icon + title; the
  // notes view filtered to a label shows a clearable chip instead. The plain
  // dashboard shows neither. This context strip is what replaces the native
  // drawer header the destinations used to carry.
  const destination: { Icon: LucideIcon; title: string } | null =
    variant === 'archived' ? { Icon: Archive, title: t('dashboard.tabArchive') } :
    variant === 'trash' ? { Icon: Trash2, title: t('dashboard.tabBin') } :
    variant === 'my-tasks' ? { Icon: Clipboard, title: t('dashboard.tabMyTasks') } :
    null;
  const showLabelChip = variant === 'notes' && !!labelName;

  return (
    <>
      <View style={[styles.topControlsRow, { paddingTop: topInset }]}>
        <TouchableOpacity
          style={[styles.menuButton, { backgroundColor: colors.surface, borderColor: colors.searchBorder }]}
          onPress={onToggleDrawer}
          testID="drawer-toggle"
          accessibilityLabel={t('nav.openMenu')}
          accessibilityRole="button"
        >
          <Menu size={22} color={colors.text} />
        </TouchableOpacity>
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

      {destination && (
        <View style={styles.contextStrip} testID="view-title">
          <destination.Icon size={18} color={colors.textSecondary} style={styles.contextTitleIcon} />
          <Text style={[styles.contextTitleText, { color: colors.text }]} testID="view-title-text">{destination.title}</Text>
        </View>
      )}

      {showLabelChip && (
        <View style={styles.contextStrip}>
          <View
            style={[styles.labelChip, { backgroundColor: colors.primaryLight, borderColor: colors.primary }]}
            testID="label-filter-chip"
          >
            <Tag size={13} color={colors.primary} />
            <Text style={[styles.labelChipText, { color: colors.primary }]} numberOfLines={1}>
              {labelName}
            </Text>
            <TouchableOpacity
              onPress={onClearLabel}
              testID="clear-label-filter"
              accessibilityRole="button"
              accessibilityLabel={t('dashboard.clearLabelFilter')}
              hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
            >
              <X size={14} color={colors.primary} />
            </TouchableOpacity>
          </View>
        </View>
      )}

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
