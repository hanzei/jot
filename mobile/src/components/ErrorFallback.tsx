import { useContext } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaInsetsContext, initialWindowMetrics } from 'react-native-safe-area-context';
import type { ThemeColors } from '../theme/colors';

export interface ErrorFallbackAction {
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
}

interface ErrorFallbackProps {
  colors: ThemeColors;
  title: string;
  message: string;
  /** The caught error's message: shown so a user can quote it, never note content. */
  errorMessage: string;
  actions: ErrorFallbackAction[];
  testID: string;
}

/**
 * Presentational fallback for an error boundary. Takes colors and strings as
 * props rather than from context, because the root boundary renders it with
 * the whole provider tree gone.
 */
export default function ErrorFallback({ colors, title, message, errorMessage, actions, testID }: ErrorFallbackProps) {
  // The root boundary renders this above SafeAreaProvider, so fall back to the
  // launch-time insets there; the provider would hold its children until native
  // insets arrive, which a crash screen should not wait on.
  const insets = useContext(SafeAreaInsetsContext)
    ?? initialWindowMetrics?.insets
    ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return (
    <View
      testID={testID}
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
        <Text style={[styles.errorMessage, { color: colors.textMuted, borderColor: colors.border }]} numberOfLines={4}>
          {errorMessage}
        </Text>
        <View style={styles.actions}>
          {actions.map((action) => (
            <TouchableOpacity
              key={action.testID}
              testID={action.testID}
              onPress={action.onPress}
              accessibilityRole="button"
              style={[
                styles.button,
                action.primary
                  ? { backgroundColor: colors.primary }
                  : [styles.buttonOutline, { borderColor: colors.border }],
              ]}
            >
              <Text style={[styles.buttonText, { color: action.primary ? '#fff' : colors.text }]}>{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  message: {
    fontSize: 15,
    textAlign: 'center',
  },
  errorMessage: {
    fontSize: 12,
    fontFamily: 'monospace',
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
  actions: {
    gap: 12,
    marginTop: 8,
  },
  button: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonOutline: {
    borderWidth: 1,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
