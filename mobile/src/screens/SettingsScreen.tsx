import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { ThemePreference } from '../types';

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'system', label: 'System', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Light', icon: 'sunny-outline' },
  { value: 'dark', label: 'Dark', icon: 'moon-outline' },
];

export default function SettingsScreen() {
  const navigation = useNavigation();
  const { colors, themePreference, updateTheme } = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          testID="settings-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>Theme</Text>
        {THEME_OPTIONS.map((option) => {
          const isActive = themePreference === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[styles.optionRow, isActive && { backgroundColor: colors.primaryLight }]}
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
              <Text style={[styles.optionText, { color: colors.text }, isActive && { color: colors.primary, fontWeight: '600' }]}>
                {option.label}
              </Text>
              {isActive && (
                <Ionicons name="checkmark" size={20} color={colors.primary} style={styles.checkIcon} />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
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
  optionText: {
    fontSize: 15,
    flex: 1,
  },
  checkIcon: {
    marginLeft: 'auto',
  },
});
