import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import ErrorBoundary, { type ErrorBoundaryFallbackProps } from './ErrorBoundary';
import ErrorFallback, { type ErrorFallbackAction } from './ErrorFallback';

interface ScreenNavigation {
  canGoBack: () => boolean;
  goBack: () => void;
}

function ScreenErrorFallback({ error, reset, navigation }: ErrorBoundaryFallbackProps & { navigation: ScreenNavigation }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const actions: ErrorFallbackAction[] = [
    { label: t('errorBoundary.tryAgain'), onPress: reset, testID: 'screen-error-try-again', primary: true },
  ];
  if (navigation.canGoBack()) {
    actions.push({ label: t('common.back'), onPress: () => navigation.goBack(), testID: 'screen-error-back' });
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
 * `screenLayout` for a navigator: wraps every screen in its own boundary, so
 * one note that fails to render takes down its screen rather than the whole
 * app. It sits inside the providers, so its fallback can use the theme and
 * offer a way back.
 */
export function screenErrorLayout({ route, navigation, children }: {
  route: { name: string };
  navigation: ScreenNavigation;
  children: ReactElement;
}) {
  return (
    <ErrorBoundary name={route.name} fallback={(props) => <ScreenErrorFallback {...props} navigation={navigation} />}>
      {children}
    </ErrorBoundary>
  );
}
