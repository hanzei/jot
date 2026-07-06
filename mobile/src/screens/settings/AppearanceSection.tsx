import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  ScrollView,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronUp } from 'lucide-react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { useAuth } from '../../store/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { updateMe } from '../../api/settings';
import { cacheAuthProfile } from '../../api/client';
import { enqueueOperation, isQueueableError } from '../../db/syncQueue';
import { SUPPORTED_LANGUAGES, getLanguagePreference, resolveLanguage, type LanguagePreference } from '../../i18n/language';
import { displayMessage, extractApiError } from '../../i18n/utils';
import i18n from '../../i18n';
import type { ThemePreference } from '@jot/shared';
import { styles } from './styles';

export default function AppearanceSection() {
  const { user, settings, setSettings, isLocalMode } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const db = useSQLiteContext();

  const [languagePref, setLanguagePref] = useState<LanguagePreference>(
    getLanguagePreference(settings?.language),
  );
  const [languageError, setLanguageError] = useState('');
  const [themePref, setThemePref] = useState<ThemePreference>(settings?.theme ?? 'system');
  const [themeError, setThemeError] = useState('');
  const [openDropdown, setOpenDropdown] = useState<'language' | 'theme' | null>(null);

  useEffect(() => {
    setLanguagePref(getLanguagePreference(settings?.language));
    setThemePref(settings?.theme ?? 'system');
  }, [settings?.language, settings?.theme]);

  const handleLanguageChange = useCallback(async (language: LanguagePreference) => {
    const previousLanguage = languagePref;
    const previousSettings = settings;

    setLanguageError('');
    setLanguagePref(language);
    void i18n.changeLanguage(resolveLanguage(language));

    const newSettings = previousSettings ? { ...previousSettings, language } : null;
    if (newSettings) {
      setSettings(newSettings);
      if (user) void cacheAuthProfile({ user, settings: newSettings });
    }

    if (!isLocalMode) {
      try {
        const { settings: updatedSettings } = await updateMe({ language });
        setSettings(updatedSettings);
        if (user) void cacheAuthProfile({ user, settings: updatedSettings });
      } catch (err: unknown) {
        if (isQueueableError(err)) {
          await enqueueOperation(db, {
            operation: 'updateSettings',
            endpoint: '/users/me',
            method: 'PATCH',
            body: { language },
          });
        } else {
          setLanguagePref(previousLanguage);
          void i18n.changeLanguage(resolveLanguage(previousLanguage));
          if (previousSettings) {
            setSettings(previousSettings);
            if (user) void cacheAuthProfile({ user, settings: previousSettings });
          }
          setLanguageError(extractApiError(err) ?? 'settings.failedUpdateLanguage');
        }
      }
    }
  }, [languagePref, settings, user, setSettings, isLocalMode, db]);

  const handleThemeChange = useCallback(async (theme: ThemePreference) => {
    const prev = themePref;
    const previousSettings = settings;
    setThemeError('');
    setThemePref(theme);

    const newSettings = previousSettings ? { ...previousSettings, theme } : null;
    if (newSettings) {
      setSettings(newSettings);
      if (user) void cacheAuthProfile({ user, settings: newSettings });
    }

    if (!isLocalMode) {
      try {
        const { settings: updatedSettings } = await updateMe({ theme });
        setSettings(updatedSettings);
        if (user) void cacheAuthProfile({ user, settings: updatedSettings });
      } catch (err: unknown) {
        if (isQueueableError(err)) {
          await enqueueOperation(db, {
            operation: 'updateSettings',
            endpoint: '/users/me',
            method: 'PATCH',
            body: { theme },
          });
        } else {
          setThemePref(prev);
          if (previousSettings) {
            setSettings(previousSettings);
            if (user) void cacheAuthProfile({ user, settings: previousSettings });
          }
          setThemeError(extractApiError(err) ?? 'settings.failedUpdateTheme');
        }
      }
    }
  }, [settings, user, setSettings, isLocalMode, themePref, db]);

  const languageOptions: { value: LanguagePreference; label: string }[] = [
    { value: 'system', label: t('settings.languageSystem') },
    ...SUPPORTED_LANGUAGES.map((language) => ({
      value: language,
      label: t(`settings.language_${language}`),
    })),
  ];
  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];
  const selectedLanguageLabel = languageOptions.find(option => option.value === languagePref)?.label
    ?? t('settings.languageSystem');
  const selectedThemeLabel = themeOptions.find(option => option.value === themePref)?.label
    ?? t('settings.themeSystem');
  const dropdownOptions = openDropdown === 'language' ? languageOptions : themeOptions;
  const selectedDropdownValue = openDropdown === 'language' ? languagePref : themePref;
  const LanguageChevron = openDropdown === 'language' ? ChevronUp : ChevronDown;
  const ThemeChevron = openDropdown === 'theme' ? ChevronUp : ChevronDown;

  return (
    <>
      <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.themeSection')}</Text>
        <Text style={[styles.label, { color: colors.icon }]}>{t('settings.languageLabel')}</Text>
        <TouchableOpacity
          style={[
            styles.dropdownTrigger,
            { borderColor: colors.border, backgroundColor: colors.inputBackground },
          ]}
          onPress={() => setOpenDropdown('language')}
          testID="settings-language-dropdown"
          accessibilityLabel={`${t('settings.languageLabel')}, ${selectedLanguageLabel}`}
          accessibilityRole="button"
          accessibilityState={{ expanded: openDropdown === 'language' }}
        >
          <Text style={[styles.dropdownTriggerText, { color: colors.text }]}>{selectedLanguageLabel}</Text>
          <LanguageChevron size={18} color={colors.icon} accessible={false} />
        </TouchableOpacity>
        {languageError !== '' && (
          <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, languageError)}</Text>
        )}
        <Text style={[styles.label, styles.preferenceLabel, { color: colors.icon }]}>{t('settings.themeLabel')}</Text>
        <TouchableOpacity
          style={[
            styles.dropdownTrigger,
            { borderColor: colors.border, backgroundColor: colors.inputBackground },
          ]}
          onPress={() => setOpenDropdown('theme')}
          testID="settings-theme-dropdown"
          accessibilityLabel={`${t('settings.themeLabel')}, ${selectedThemeLabel}`}
          accessibilityRole="button"
          accessibilityState={{ expanded: openDropdown === 'theme' }}
        >
          <Text style={[styles.dropdownTriggerText, { color: colors.text }]}>{selectedThemeLabel}</Text>
          <ThemeChevron size={18} color={colors.icon} accessible={false} />
        </TouchableOpacity>
        {themeError !== '' && (
          <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, themeError)}</Text>
        )}
      </View>
      <Modal
        visible={openDropdown !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setOpenDropdown(null)}
      >
        <Pressable
          style={[styles.dropdownOverlay, { backgroundColor: colors.overlay }]}
          onPress={() => setOpenDropdown(null)}
          testID="settings-dropdown-overlay"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <View
            style={[styles.dropdownMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}
            accessibilityRole="menu"
            onStartShouldSetResponder={() => true}
          >
            <ScrollView style={styles.dropdownOptionsList}>
              {dropdownOptions.map((option) => {
                const isSelected = selectedDropdownValue === option.value;
                const optionType = openDropdown === 'language' ? 'language' : 'theme';
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.dropdownOption,
                      { borderBottomColor: colors.borderLight },
                      isSelected && { backgroundColor: colors.primaryLight },
                    ]}
                    onPress={() => {
                      if (isSelected) {
                        setOpenDropdown(null);
                        return;
                      }
                      if (optionType === 'language') {
                        void handleLanguageChange(option.value as LanguagePreference);
                      } else {
                        void handleThemeChange(option.value as ThemePreference);
                      }
                      setOpenDropdown(null);
                    }}
                    testID={`settings-${optionType}-${option.value}`}
                    accessibilityRole="menuitem"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.dropdownOptionText,
                        { color: colors.text },
                        isSelected && { color: colors.primary, fontWeight: '600' },
                      ]}
                    >
                      {option.label}
                    </Text>
                    {isSelected && <Check size={16} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
