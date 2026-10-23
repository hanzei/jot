import { useColorScheme } from 'react-native';
import i18n from '../i18n';
import { getColors } from '../theme/colors';
import { getBaseUrl } from '../api/client';
import { shareDiagnosticsReport } from '../utils/diagnosticsReport';
import type { ErrorBoundaryFallbackProps } from './ErrorBoundary';
import ErrorFallback from './ErrorFallback';

/**
 * Fallback for the root error boundary in App.tsx. Everything below that
 * boundary is gone, so this reads the i18n instance and the system color
 * scheme directly rather than through providers, and builds its diagnostics
 * report without the database or OfflineContext.
 */
export default function CrashScreen({ error, componentStack, reset }: ErrorBoundaryFallbackProps) {
  const colors = getColors(useColorScheme());

  const handleShare = async () => {
    try {
      await shareDiagnosticsReport({
        serverUrl: getBaseUrl(),
        isConnected: null,
        sync: null,
        crash: {
          name: error.name,
          message: error.message,
          stack: error.stack ?? null,
          componentStack,
        },
      });
    } catch (shareError) {
      console.warn('Failed to share diagnostics from crash screen:', shareError);
    }
  };

  return (
    <ErrorFallback
      testID="crash-screen"
      colors={colors}
      title={i18n.t('errorBoundary.title')}
      message={i18n.t('errorBoundary.message')}
      errorMessage={error.message}
      actions={[
        { label: i18n.t('errorBoundary.tryAgain'), onPress: reset, testID: 'crash-screen-try-again', primary: true },
        { label: i18n.t('errorBoundary.shareDiagnostics'), onPress: () => { void handleShare(); }, testID: 'crash-screen-share-diagnostics' },
      ]}
    />
  );
}
