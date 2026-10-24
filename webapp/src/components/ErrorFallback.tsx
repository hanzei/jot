import { useState } from 'react';
import i18n from '@/i18n';
import { pageDiagnosticsReport } from '@/utils/diagnosticsReport';
import { useServerInfo } from '@/hooks/useServerInfo';
import type { ErrorBoundaryFallbackProps } from '@/components/ErrorBoundary';

interface ErrorFallbackProps extends ErrorBoundaryFallbackProps {
  /**
   * `root` replaces the whole app and offers a reload; `section` replaces one
   * route inside the layout and offers to re-render it.
   */
  variant: 'root' | 'section';
}

type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Fallback for the error boundaries. Strings come from the i18n instance
 * directly rather than a hook, so it renders whatever failed below it.
 */
export default function ErrorFallback({ error, componentStack, reset, variant }: ErrorFallbackProps) {
  const serverInfo = useServerInfo();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const t = i18n.t.bind(i18n);

  const handleCopy = async () => {
    const details = pageDiagnosticsReport(serverInfo, {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      componentStack: componentStack?.trim() ?? null,
    });
    try {
      await navigator.clipboard.writeText(details);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  const Heading = variant === 'root' ? 'h1' : 'h2';
  const content = (
    <div role="alert" data-testid={`error-fallback-${variant}`} className="max-w-lg w-full text-center space-y-4">
      <Heading className="text-xl font-semibold text-gray-900 dark:text-white">{t('errorBoundary.title')}</Heading>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {variant === 'root' ? t('errorBoundary.message') : t('errorBoundary.sectionMessage')}
      </p>
      <pre className="text-left text-xs whitespace-pre-wrap break-words font-mono text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md p-3 max-h-32 overflow-auto">
        {error.message}
      </pre>
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={variant === 'root' ? () => window.location.reload() : reset}
          className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900"
        >
          {variant === 'root' ? t('errorBoundary.reload') : t('errorBoundary.tryAgain')}
        </button>
        <button
          type="button"
          onClick={() => { void handleCopy(); }}
          className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900"
        >
          {t('errorBoundary.copyDetails')}
        </button>
      </div>
      <p aria-live="polite" className="text-sm text-gray-600 dark:text-gray-300 min-h-5">
        {copyStatus === 'copied' && t('errorBoundary.copied')}
        {copyStatus === 'failed' && t('errorBoundary.copyFailed')}
      </p>
    </div>
  );

  if (variant === 'root') {
    return (
      <main className="min-h-screen flex items-center justify-center p-4 bg-gray-50 dark:bg-slate-900">
        {content}
      </main>
    );
  }
  return <div className="flex justify-center p-4 sm:p-8">{content}</div>;
}
