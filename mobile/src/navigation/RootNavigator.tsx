import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NoteType } from '@jot/shared';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { SSEProvider } from '../store/SSEContext';
import TopBanners from '../components/TopBanners';
import AuthStack from './AuthStack';
import MainDrawer from './MainDrawer';
import NoteEditorScreen from '../screens/NoteEditorScreen';
import ShareScreen from '../screens/ShareScreen';
import SettingsScreen from '../screens/SettingsScreen';
import SyncFailuresScreen from '../screens/SyncFailuresScreen';
import DiagnosticsScreen from '../screens/DiagnosticsScreen';
import LogsFullscreenScreen from '../screens/LogsFullscreenScreen';
import ConnectToServerScreen from '../screens/ConnectToServerScreen';

/** A view's position and size in window coordinates (from `measureInWindow`). */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RootStackParamList = {
  MainDrawer: undefined;
  // sharedText pre-fills a brand-new note (noteId null) when opened from a
  // share intent. initialNoteType opens a brand-new note as a text note or a
  // checklist (used by the app-icon "New note" / "New list" quick actions);
  // defaults to text. readOnly opens a trashed note in a view-only state (all
  // editing disabled; overflow menu offers only Restore / Delete-forever).
  // originRect is the tapped card's on-screen rect, used to zoom the editor
  // open from (and closed back onto) that card. originColor is that card's
  // note color, used to seed the editor's background so the zoom-open shows
  // the right color immediately instead of flashing white until the note
  // hydrates from cache.
  NoteEditor: {
    noteId: string | null;
    sharedText?: string;
    initialNoteType?: NoteType;
    readOnly?: boolean;
    originRect?: LayoutRect;
    originColor?: string;
  };
  Share: { noteId: string };
  Settings: undefined;
  SyncFailures: undefined;
  Diagnostics: undefined;
  LogsFullscreen: undefined;
  ConnectToServer: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Identify a NoteEditor/Share screen by the note it targets. Without this,
// React Navigation matches routes by name only, so a deep link to a different
// note while an editor is already open navigates back to the existing instance
// and merely merges the new params. NoteEditorScreen seeds its state from the
// initial params and does not react to later param changes, so it would keep
// showing the first note. Keying on noteId makes a deep link to a different
// note push a fresh screen instead of reusing the stale one.
export const getNoteScreenId = ({ params }: { params?: { noteId?: string | null } }): string | undefined =>
  params?.noteId ?? undefined;

function AuthenticatedStack() {
  return (
    <SSEProvider>
      <View style={styles.flex}>
        <TopBanners />
        <Stack.Navigator>
          <Stack.Screen name="MainDrawer" component={MainDrawer} options={{ headerShown: false }} />
          <Stack.Screen
            name="NoteEditor"
            component={NoteEditorScreen}
            getId={getNoteScreenId}
            options={{
              headerShown: false,
              // The editor animates its own transform to zoom open from (and
              // closed back onto) the tapped card. A transparent modal keeps the
              // dashboard rendered behind so the card shows through while the
              // editor is scaled down; the native present/dismiss animation is
              // disabled so only the zoom is visible, and the swipe gesture is
              // off so every exit routes through that zoom.
              presentation: 'transparentModal',
              animation: 'none',
              gestureEnabled: false,
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
          <Stack.Screen
            name="Share"
            component={ShareScreen}
            getId={getNoteScreenId}
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
          <Stack.Screen
            name="SyncFailures"
            component={SyncFailuresScreen}
            options={{
              headerShown: false,
              presentation: 'modal',
            }}
          />
          <Stack.Screen
            name="Diagnostics"
            component={DiagnosticsScreen}
            options={{
              headerShown: false,
              presentation: 'modal',
            }}
          />
          <Stack.Screen
            name="LogsFullscreen"
            component={LogsFullscreenScreen}
            options={{
              headerShown: false,
              presentation: 'modal',
            }}
          />
          <Stack.Screen
            name="ConnectToServer"
            component={ConnectToServerScreen}
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
