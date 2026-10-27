import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { styles } from './styles';

export interface FormatOption<T extends string> {
  value: T;
  labelKey: string;
}

interface FormatRadioGroupProps<T extends string> {
  labelKey: string;
  options: FormatOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  /** Each option's testID is `${testIDPrefix}-${value}`. */
  testIDPrefix: string;
}

/** A labelled row of format choices, as the import and export sections use. */
export default function FormatRadioGroup<T extends string>({
  labelKey,
  options,
  value,
  onChange,
  disabled,
  testIDPrefix,
}: FormatRadioGroupProps<T>) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <>
      <Text style={[styles.formatLabel, { color: colors.text }]}>{t(labelKey)}</Text>
      <View style={styles.formatRow} accessibilityRole="radiogroup">
        {options.map(option => {
          const isSelected = value === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.formatOption,
                { borderColor: isSelected ? colors.primary : colors.border },
                isSelected && { backgroundColor: colors.primary },
              ]}
              onPress={() => onChange(option.value)}
              disabled={disabled}
              testID={`${testIDPrefix}-${option.value}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected, disabled }}
            >
              <Text style={[styles.formatOptionText, { color: isSelected ? '#fff' : colors.text }]}>
                {t(option.labelKey)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </>
  );
}
