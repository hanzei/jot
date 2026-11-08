import { TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Check, DropletOff } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import BottomSheet from './BottomSheet';
import { hasCustomNoteColor } from '../utils/colorContrast';
import { DEFAULT_NOTE_COLOR, NOTE_COLORS, LIGHT_NOTE_COLORS, NOTE_COLOR_NAME_KEYS } from '@jot/shared';

const CHECK_SIZE = 22;
const CHECK_STROKE = 3;

interface ColorPickerProps {
  visible: boolean;
  currentColor: string;
  onSelect: (color: string) => void;
  onClose: () => void;
}

export default function ColorPicker({ visible, currentColor, onSelect, onClose }: ColorPickerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // Selection must read at a glance on every swatch, including the pale ones:
  // a primary-coloured ring (as the webapp's ring-2 ring-blue-500) plus a bold
  // check, rather than a thin grey check alone.
  const selectedRing = { borderWidth: 3, borderColor: colors.primary };
  const isDefaultSelected = !hasCustomNoteColor(currentColor);

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('note.changeColor')} testID="color-picker">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.palette}
      >
        {NOTE_COLORS.map((color) => {
          const select = () => {
            onSelect(color);
            onClose();
          };
          const testID = `color-swatch-${color.replace('#', '')}`;
          const accessibilityLabel = t(NOTE_COLOR_NAME_KEYS[color] ?? 'note.changeColor');

          // The default "colour" is no colour: the note follows the app theme,
          // so its swatch shows the theme's own surface plus a "no colour"
          // glyph instead of a solid white that dark mode never renders.
          if (color === DEFAULT_NOTE_COLOR) {
            return (
              <TouchableOpacity
                key={color}
                style={[
                  styles.colorCircle,
                  styles.defaultCircle,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  isDefaultSelected && selectedRing,
                ]}
                onPress={select}
                testID={testID}
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ selected: isDefaultSelected }}
              >
                {isDefaultSelected
                  ? <Check size={CHECK_SIZE} strokeWidth={CHECK_STROKE} color={colors.text} />
                  : <DropletOff size={18} color={colors.icon} />}
              </TouchableOpacity>
            );
          }

          const selected = currentColor.toLowerCase() === color;
          return (
            <TouchableOpacity
              key={color}
              style={[
                styles.colorCircle,
                { backgroundColor: color },
                LIGHT_NOTE_COLORS.has(color) && { borderWidth: 1, borderColor: colors.border },
                selected && selectedRing,
              ]}
              onPress={select}
              testID={testID}
              accessibilityLabel={accessibilityLabel}
              accessibilityState={{ selected }}
            >
              {selected && (
                <Check size={CHECK_SIZE} strokeWidth={CHECK_STROKE} color="#1a1a1a" />
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  palette: {
    gap: 10,
  },
  colorCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  defaultCircle: {
    borderWidth: 1,
  },
});
