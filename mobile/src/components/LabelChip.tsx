import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { getEffectiveColors } from '../theme/colors';

interface LabelChipProps {
  name: string;
  /** Whether the chip sits on a note with a custom background colour. */
  hasNoteColor: boolean;
  /** `small` for note cards in the list, `regular` for the note editor. */
  size?: 'small' | 'regular';
  /** Makes the chip tappable; without it the chip is plain display. */
  onPress?: (() => void) | undefined;
  testID?: string | undefined;
  accessibilityLabel?: string | undefined;
}

/**
 * A label pill, shared by note cards and the note editor so both pick their
 * colours from one place: the theme's chip tokens on an uncoloured note, the
 * fixed light-mode overrides from getEffectiveColors on a coloured one.
 */
export default function LabelChip({
  name,
  hasNoteColor,
  size = 'regular',
  onPress,
  testID,
  accessibilityLabel,
}: LabelChipProps) {
  const { colors } = useTheme();
  const { chipBackground, chipText } = getEffectiveColors(hasNoteColor, colors);
  const chipStyle = [size === 'small' ? styles.chipSmall : styles.chip, { backgroundColor: chipBackground }];
  const text = (
    <Text style={[size === 'small' ? styles.textSmall : styles.text, { color: chipText }]}>{name}</Text>
  );

  if (!onPress) {
    return <View style={chipStyle} testID={testID}>{text}</View>;
  }
  return (
    <TouchableOpacity
      style={chipStyle}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {text}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  text: {
    fontSize: 12,
    fontWeight: '500',
  },
  chipSmall: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  textSmall: {
    fontSize: 11,
  },
});
