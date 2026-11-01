import { useContext } from 'react';
import { Modal, View, Text, TouchableOpacity, Pressable, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { ExternalLink } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { InlineLink } from '@jot/shared';
import { useTheme } from '../theme/ThemeContext';

interface ItemLinksSheetProps {
  visible: boolean;
  links: InlineLink[];
  onClose: () => void;
  onOpen: (href: string) => void;
}

/** A link's host, for telling apart entries whose labels look alike. */
function hostOf(href: string): string {
  if (href.startsWith('mailto:')) return href.slice('mailto:'.length);
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(href);
  return match?.[1] ?? href;
}

/**
 * Bottom sheet listing an item's links, for the row's "open link" button when
 * there is more than one to choose from (docs/specs/markdown-rendering.md §1.2).
 * Laid out like AddImageActionSheet.
 */
export default function ItemLinksSheet({ visible, links, onClose, onOpen }: ItemLinksSheetProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay }]} onPress={onClose}>
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
                  onOpen(link.href);
                }}
                testID="item-links-sheet-link"
                accessibilityRole="link"
                accessibilityLabel={t('note.openItemLink', { label: link.label })}
              >
                <ExternalLink size={22} color={colors.icon} />
                <View style={styles.rowText}>
                  <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
                    {link.label}
                  </Text>
                  {link.label !== link.href && (
                    <Text style={[styles.host, { color: colors.textSecondary }]} numberOfLines={1}>
                      {hostOf(link.href)}
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
