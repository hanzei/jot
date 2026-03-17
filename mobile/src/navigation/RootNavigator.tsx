import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { SSEProvider } from '../store/SSEContext';
import OfflineBanner from '../components/OfflineBanner';
import AuthStack from './AuthStack';
import MainDrawer from './MainDrawer';
import NoteEditorScreen from '../screens/NoteEditorScreen';
import ShareScreen from '../screens/ShareScreen';
import SettingsScreen from '../screens/SettingsScreen';

export type RootStackParamList = {
  MainDrawer: undefined;
  NoteEditor: { noteId: string | null };
  Share: { noteId: string };
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function AuthenticatedStack() {
  return (
    <SSEProvider>
      <View style={styles.flex}>
        <OfflineBanner />
        <Stack.Navigator>
          <Stack.Screen name="MainDrawer" component={MainDrawer} options={{ headerShown: false }} />
          <Stack.Screen
            name="NoteEditor"
            component={NoteEditorScreen}
            options={{
              headerShown: false,
              presentation: 'modal',
            }}
          />
          <Stack.Screen
            name="Share"
            component={ShareScreen}
            options={{
              headerShown: false,
              presentation: 'modal',
            }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              headerShown: false,
              presentation: 'modal',
            }}
          />
        </Stack.Navigator>
      </View>
    </SSEProvider>
  );
}

export default function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth();
  const { colors } = useTheme();

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return isAuthenticated ? <AuthenticatedStack /> : <AuthStack />;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
