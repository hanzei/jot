import type { ReactNode } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import ErrorBoundary, { type ErrorBoundaryFallbackProps } from './ErrorBoundary';
import ErrorFallback from './ErrorFallback';

function ScreenErrorFallback({ error, reset }: ErrorBoundaryFallbackProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
  const actions = [
    { label: t('errorBoundary.tryAgain'), onPress: reset, testID: 'screen-error-try-again', primary: true },
  ];
  if (navigation.canGoBack()) {
    actions.push({ label: t('common.back'), onPress: () => navigation.goBack(), testID: 'screen-error-back', primary: false });
  }
  return (
    <ErrorFallback
      testID="screen-error"
      colors={colors}
      title={t('errorBoundary.title')}
      message={t('errorBoundary.screenMessage')}
      errorMessage={error.message}
      actions={actions}
    />
  );
}

/**
 * Screen-level boundary, so one note that fails to render takes down its
 * screen rather than the whole app. Sits inside the providers and navigator,
 * so its fallback can use the theme and offer a way back.
 */
export default function ScreenErrorBoundary({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary name={name} fallback={(props) => <ScreenErrorFallback {...props} />}>
      {children}
    </ErrorBoundary>
  );
}
