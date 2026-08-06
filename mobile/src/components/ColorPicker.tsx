import { useContext } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Pressable,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { NOTE_COLORS, LIGHT_NOTE_COLORS } from '@jot/shared';

interface ColorPickerProps {
  visible: boolean;
  currentColor: string;
  onSelect: (color: string) => void;
  onClose: () => void;
}

const COLOR_LABELS: Record<string, string> = {
  '#ffffff': 'note.colorWhite',
  '#f28b82': 'note.colorCoral',
  '#fbbc04': 'note.colorYellow',
  '#ccff90': 'note.colorLime',
  '#a7ffeb': 'note.colorTeal',
  '#aecbfa': 'note.colorPeriwinkle',
  '#d7aefb': 'note.colorLavender',
  '#fdcfe8': 'note.colorPink',
  '#e6c9a8': 'note.colorSand',
  '#e8eaed': 'note.colorGray',
};

export default function ColorPicker({ visible, currentColor, onSelect, onClose }: ColorPickerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay }]} onPress={onClose}>
        <View style={[styles.sheet, { backgroundColor: colors.sheetBackground, paddingBottom: insets.bottom }]}>
          <Pressable>
            <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
            <Text style={[styles.title, { color: colors.text }]}>{t('note.changeColor')}</Text>
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
                  accessibilityLabel={t(COLOR_LABELS[color] ?? 'note.changeColor')}
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
    marginBottom: 16,
  },
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
