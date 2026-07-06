import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ChevronRight } from 'lucide-react-native';
import { useTheme } from '../../theme/ThemeContext';
import type { RootStackParamList } from '../../navigation/RootNavigator';
import { styles } from './styles';

export default function DeveloperSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Settings'>>();

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('diagnostics.developerSection')}</Text>
      <TouchableOpacity
        style={styles.aboutToggle}
        onPress={() => navigation.navigate('Diagnostics')}
        testID="settings-diagnostics"
        accessibilityLabel={t('diagnostics.title')}
        accessibilityRole="button"
      >
        <Text style={[styles.aboutToggleText, { color: colors.icon }]}>{t('diagnostics.title')}</Text>
        <ChevronRight size={20} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}
