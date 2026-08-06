import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../theme/ThemeContext';
import type { RootStackParamList } from '../../navigation/RootNavigator';
import { styles } from './styles';

export default function ConnectToServerSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('upgrade.settingsSectionTitle')}</Text>
      <Text style={[styles.sectionDescription, { color: colors.textSecondary }]}>{t('upgrade.settingsSectionDescription')}</Text>
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.primary }]}
        onPress={() => navigation.navigate('ConnectToServer')}
        testID="settings-connect-to-server"
        accessibilityRole="button"
        accessibilityLabel={t('upgrade.connectToServer')}
      >
        <Text style={styles.primaryButtonText}>{t('upgrade.connectToServer')}</Text>
      </TouchableOpacity>
    </View>
  );
}
