import { Modal, View, Text, TouchableOpacity, Pressable, StyleSheet } from 'react-native';
import { ExternalLink } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { InlineLink } from '@jot/shared';
import { useTheme } from '../theme/ThemeContext';
import { useDeviceSafeAreaInsets } from './ContentSafeArea';
import { openUrl } from '../utils/openUrl';

interface ItemLinksSheetProps {
  visible: boolean;
  links: InlineLink[];
  onClose: () => void;
}

/**
 * Bottom sheet listing an item's links, for the row's "open link" button when
 * there is more than one to choose from (docs/specs/markdown-rendering.md §1.2).
 * Laid out like AddImageActionSheet.
 */
export default function ItemLinksSheet({ visible, links, onClose }: ItemLinksSheetProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // A Modal renders above the connectivity banners, so it takes the device's
  // insets rather than the content area's (mobile/CLAUDE.md).
  const insets = useDeviceSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[styles.overlay, { backgroundColor: colors.overlay }]}
        onPress={onClose}
        testID="item-links-sheet-overlay"
      >
        <View style={[styles.sheet, { backgroundColor: colors.sheetBackground, paddingBottom: insets.bottom + 8 }]}>
          <Pressable>
            <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
            <Text style={[styles.title, { color: colors.text }]}>{t('note.openItemLinks')}</Text>

            {links.map((link) => (
              <TouchableOpacity
                key={link.href}
                style={styles.row}
                onPress={() => {
                  onClose();
                  void openUrl(link.href);
                }}
                testID="item-links-sheet-link"
                accessibilityRole="link"
                accessibilityLabel={t('note.openItemLink', { label: link.label })}
                // The label replaces the row's children for a screen reader, so
                // the host line that tells look-alike labels apart goes here.
                accessibilityHint={link.host ?? undefined}
              >
                <ExternalLink size={22} color={colors.icon} />
                <View style={styles.rowText}>
                  <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
                    {link.label}
                  </Text>
                  {link.host !== null && (
                    <Text style={[styles.host, { color: colors.textSecondary }]} numberOfLines={1}>
                      {link.host}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            ))}
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
    padding: 16,
  },
  handle: {
    width: 40,
    height: 5,
    borderRadius: 2.5,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    fontSize: 16,
  },
  host: {
    fontSize: 13,
    marginTop: 2,
  },
});
