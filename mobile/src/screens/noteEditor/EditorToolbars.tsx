import { View, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Bold, Heading, Italic, List, ListTodo, Strikethrough } from 'lucide-react-native';
import { useTheme } from '../../theme/ThemeContext';
import { styles } from './styles';

interface MarkdownToolbarProps {
  onBold: () => void;
  onItalic: () => void;
  onStrikethrough: () => void;
  /**
   * The three block actions, supplied together or not at all. Omitting them
   * gives the inline-only bar a list-item row gets — an item is lexed as inline
   * content, so `## `, `- ` and `- [ ] ` stay literal source there
   * (docs/specs/markdown-rendering.md §2.1) and a button for them would write
   * characters guaranteed never to render. Same split as the webapp toolbar's
   * `variant` prop (webapp/src/components/MarkdownToolbar.tsx).
   */
  onHeading?: () => void;
  onBullet?: () => void;
  onCheckbox?: () => void;
  backgroundColor: string;
  hasNoteColor: boolean;
}

const HIT_SLOP = { top: 8, right: 4, bottom: 8, left: 4 };
const ICON_SIZE = 20;

/**
 * Markdown formatting buttons, over a text note's content or a list note's
 * rows. Rendered inline on Android and inside an InputAccessoryView on iOS —
 * both wrap this same content, so the buttons stay identical across platforms.
 *
 * Icons rather than letter glyphs: it matches the action bar below, and it
 * keeps the buttons free of text that would otherwise need translating in
 * eight locales. The accessibility labels carry the meaning.
 *
 * backgroundColor/hasNoteColor mirror the action bar below it (noteBackground
 * and the transparent-border-on-colored-notes rule) so the two bars read as
 * one continuous surface instead of a mismatched seam.
 *
 * Every button is focusable={false}: on Android a focusable view takes input
 * focus from the content input when tapped, which hides the keyboard, and the
 * editor treats a hidden keyboard as "done editing" — so a single press on
 * Bold would tear down the very input it was meant to edit. TalkBack is
 * unaffected; accessibility focus is separate from input focus.
 */
export function MarkdownToolbarContent({ onBold, onItalic, onStrikethrough, onHeading, onBullet, onCheckbox, backgroundColor, hasNoteColor }: MarkdownToolbarProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // Matches the action bar's barIconColor: a colored note's background is a
  // fixed light pastel regardless of theme, so dark-theme colors.text (near
  // white) would fail contrast against it.
  const iconColor = hasNoteColor ? '#444' : colors.text;
  return (
    <View style={[styles.formattingToolbar, { backgroundColor, borderTopColor: hasNoteColor ? 'transparent' : colors.border }]}>
      <TouchableOpacity
        onPress={onBold}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatBold')}
        testID="format-bold-btn"
      >
        <Bold size={ICON_SIZE} color={iconColor} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onItalic}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatItalic')}
        testID="format-italic-btn"
      >
        <Italic size={ICON_SIZE} color={iconColor} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onStrikethrough}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatStrikethrough')}
        testID="format-strikethrough-btn"
      >
        <Strikethrough size={ICON_SIZE} color={iconColor} />
      </TouchableOpacity>
      {onHeading && onBullet && onCheckbox && (
        <>
          <View style={[styles.fmtSep, { backgroundColor: colors.border }]} />
          {/* Cycles ## -> ### -> none, so the icon deliberately names no level. */}
          <TouchableOpacity
            onPress={onHeading}
            style={styles.fmtBtn}
            hitSlop={HIT_SLOP}
            focusable={false}
            accessibilityRole="button"
            accessibilityLabel={t('note.formatHeading')}
            testID="format-heading-btn"
          >
            <Heading size={ICON_SIZE} color={iconColor} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onBullet}
            style={styles.fmtBtn}
            hitSlop={HIT_SLOP}
            focusable={false}
            accessibilityRole="button"
            accessibilityLabel={t('note.formatBulletList')}
            testID="format-bullet-btn"
          >
            <List size={ICON_SIZE} color={iconColor} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onCheckbox}
            style={styles.fmtBtn}
            hitSlop={HIT_SLOP}
            focusable={false}
            accessibilityRole="button"
            accessibilityLabel={t('note.formatChecklist')}
            testID="format-checkbox-btn"
          >
            <ListTodo size={ICON_SIZE} color={iconColor} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}
