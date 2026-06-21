import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../theme/ThemeContext';
import { useBannerShown } from '../hooks/useBannerShown';
import { styles } from './settings/styles';
import ProfileIconSection from './settings/ProfileIconSection';
import AccountSection from './settings/AccountSection';
import ChangePasswordSection from './settings/ChangePasswordSection';
import SessionsSection from './settings/SessionsSection';
import PATsSection from './settings/PATsSection';
import ImportSection from './settings/ImportSection';
import AppearanceSection from './settings/AppearanceSection';
import DeveloperSection from './settings/DeveloperSection';
import AboutSection from './settings/AboutSection';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const bannerShown = useBannerShown();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Settings'>>();
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <View style={[styles.container, { paddingTop: bannerShown ? 0 : insets.top, backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight, backgroundColor: colors.background }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          testID="settings-back"
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('settings.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 24) + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          <ProfileIconSection />
          <AccountSection />
          <ChangePasswordSection />
          <SessionsSection />
          <PATsSection />
          <ImportSection />
          <AppearanceSection />
          <DeveloperSection />
          <AboutSection />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
