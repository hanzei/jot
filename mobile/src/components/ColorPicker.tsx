import { TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import BottomSheet from './BottomSheet';
import { NOTE_COLORS, LIGHT_NOTE_COLORS, NOTE_COLOR_NAME_KEYS } from '@jot/shared';

interface ColorPickerProps {
  visible: boolean;
  currentColor: string;
  onSelect: (color: string) => void;
  onClose: () => void;
}

export default function ColorPicker({ visible, currentColor, onSelect, onClose }: ColorPickerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('note.changeColor')} testID="color-picker">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.palette}
      >
        {NOTE_COLORS.map((color) => (
          <TouchableOpacity
            key={color}
            style={[
              styles.colorCircle,
              { backgroundColor: color },
              LIGHT_NOTE_COLORS.has(color) && { borderWidth: 1, borderColor: colors.border },
            ]}
            onPress={() => {
              onSelect(color);
              onClose();
            }}
            testID={`color-swatch-${color.replace('#', '')}`}
            accessibilityLabel={t(NOTE_COLOR_NAME_KEYS[color] ?? 'note.changeColor')}
          >
            {currentColor === color && (
              <Check
                size={18}
                color={LIGHT_NOTE_COLORS.has(color) ? '#666' : '#333'}
              />
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  palette: {
    paddingBottom: 8,
    gap: 10,
  },
  colorCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
