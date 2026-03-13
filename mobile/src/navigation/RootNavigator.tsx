import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../store/AuthContext';
import { SSEProvider } from '../store/SSEContext';
import OfflineBanner from '../components/OfflineBanner';
import AuthStack from './AuthStack';
import MainTabs from './MainTabs';
import NoteEditorScreen from '../screens/NoteEditorScreen';
import ShareScreen from '../screens/ShareScreen';

export type RootStackParamList = {
  MainTabs: undefined;
  NoteEditor: { noteId: string | null };
  Share: { noteId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function AuthenticatedStack() {
  return (
    <SSEProvider>
      <View style={styles.flex}>
        <OfflineBanner />
        <Stack.Navigator>
          <Stack.Screen name="MainTabs" component={MainTabs} options={{ headerShown: false }} />
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
        </Stack.Navigator>
      </View>
    </SSEProvider>
  );
}

export default function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#2563eb" />
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
    backgroundColor: '#fff',
  },
});
