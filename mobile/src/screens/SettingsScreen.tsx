import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { ThemePreference } from '../types';
import type { ThemeColors } from '../theme/colors';

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'system', label: 'System', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Light', icon: 'sunny-outline' },
  { value: 'dark', label: 'Dark', icon: 'moon-outline' },
];

export default function SettingsScreen() {
  const navigation = useNavigation();
  const { colors, themePreference, updateTheme } = useTheme();
  const s = getStyles(colors);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          testID="settings-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Settings</Text>
        <View style={s.headerSpacer} />
      </View>

      <View style={s.section}>
        <Text style={s.sectionTitle}>Theme</Text>
        {THEME_OPTIONS.map((option) => {
          const isActive = themePreference === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[s.optionRow, isActive && s.optionRowActive]}
              onPress={() => updateTheme(option.value)}
              testID={`theme-option-${option.value}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: isActive }}
            >
              <Ionicons
                name={option.icon}
                size={22}
                color={isActive ? colors.primary : colors.icon}
              />
              <Text style={[s.optionText, isActive && { color: colors.primary, fontWeight: '600' }]}>
                {option.label}
              </Text>
              {isActive && (
                <Ionicons name="checkmark" size={20} color={colors.primary} style={s.checkIcon} />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
    },
    headerTitle: {
      flex: 1,
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      textAlign: 'center',
    },
    headerSpacer: {
      width: 24,
    },
    section: {
      paddingHorizontal: 16,
      paddingTop: 24,
    },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 12,
    },
    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderRadius: 10,
      gap: 14,
      marginBottom: 4,
    },
    optionRowActive: {
      backgroundColor: colors.primaryLight,
    },
    optionText: {
      fontSize: 15,
      color: colors.text,
      flex: 1,
    },
    checkIcon: {
      marginLeft: 'auto',
    },
  });
}
