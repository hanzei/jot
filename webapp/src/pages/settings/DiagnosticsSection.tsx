import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { AboutInfo } from '@jot/shared';
import SettingsSectionCard from '@/pages/settings/SettingsSectionCard';
import { about } from '@/utils/api';
import { getDiagnostics, subscribeToDiagnostics } from '@/utils/diagnostics';
import { formatDiagnosticsReport } from '@/utils/diagnosticsReport';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { SSEStatus } from '@/hooks/useSSE';

const SSE_STATUS_KEYS: Record<SSEStatus, string> = {
  connecting: 'settings.diagnosticsSseConnecting',
  connected: 'settings.diagnosticsSseConnected',
  reconnecting: 'settings.diagnosticsSseReconnecting',
  disconnected: 'settings.diagnosticsSseDisconnected',
};

const SUBHEADING_CLASSES = 'text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2';

const Row = ({ label, value, testId }: { label: string; value: string; testId: string }) => (
  <div className="flex justify-between text-sm min-w-0 gap-2">
    <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
    <dd data-testid={testId} className="truncate text-gray-900 dark:text-white font-mono">{value}</dd>
  </div>
);

/**
 * Live-update state and recent failed requests, for a user to paste into a
 * bug report. Self-contained like `MobileAppPreference`: its state lives in
 * the diagnostics store, not in `Settings`. Build versions are shown in About;
 * the copied report carries them too, since it is read without that screen.
 */
const DiagnosticsSection = () => {
  const { t, i18n } = useTranslation();
  const diagnostics = useSyncExternalStore(subscribeToDiagnostics, getDiagnostics);
  const [serverInfo, setServerInfo] = useState<AboutInfo | null>(null);
  const { copied, copy } = useCopyToClipboard();

  // Not shown here (About has it), only put in the copied report.
  useEffect(() => {
    let cancelled = false;
    about.get()
      .then((info) => { if (!cancelled) setServerInfo(info); })
      .catch(() => { /* the report says null; the failure itself lands in the list below */ });
    return () => { cancelled = true; };
  }, []);

  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString(i18n.resolvedLanguage);
  const { sse, failedRequests } = diagnostics;

  const handleCopy = () => {
    void copy(formatDiagnosticsReport({
      diagnostics: getDiagnostics(),
      server: serverInfo,
      route: window.location.pathname,
      userAgent: navigator.userAgent,
      now: new Date(),
    }));
  };

  return (
    <SettingsSectionCard title={t('settings.diagnosticsSection')}>
      <div data-testid="diagnostics-section" className="space-y-5">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.diagnosticsDescription')}</p>

        <div>
          <h3 className={SUBHEADING_CLASSES}>{t('settings.diagnosticsLiveUpdates')}</h3>
          <dl className="space-y-1">
            <Row label={t('settings.diagnosticsSseStatus')} value={t(SSE_STATUS_KEYS[sse.status])} testId="diagnostics-sse-status" />
            <Row label={t('settings.diagnosticsReconnectAttempts')} value={String(sse.reconnectAttempts)} testId="diagnostics-sse-attempts" />
            <Row
              label={t('settings.diagnosticsLastEvent')}
              value={sse.lastEventAt ? formatTime(sse.lastEventAt) : t('settings.diagnosticsNoEvents')}
              testId="diagnostics-sse-last-event"
            />
          </dl>
        </div>

        <div>
          <h3 className={SUBHEADING_CLASSES}>{t('settings.diagnosticsFailedRequests', { n: failedRequests.length })}</h3>
          {failedRequests.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.diagnosticsNoFailedRequests')}</p>
          ) : (
            // Focusable so keyboard users can scroll it.
            <ul
              tabIndex={0}
              aria-label={t('settings.diagnosticsFailedRequestsList')}
              data-testid="diagnostics-failed-requests"
              className="max-h-64 overflow-y-auto divide-y divide-gray-200 dark:divide-slate-600 rounded-md border border-gray-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {/* Newest first; the store keeps them oldest first. */}
              {[...failedRequests].reverse().map((req, i) => (
                <li key={`${req.time}-${i}`} className="px-3 py-2 text-xs font-mono space-y-0.5">
                  <div className="flex justify-between gap-2 min-w-0">
                    <span className="truncate text-gray-900 dark:text-white">{req.method} {req.route}</span>
                    <span className="shrink-0 text-red-700 dark:text-red-300">
                      {req.status ?? t('settings.diagnosticsNoResponse')}{req.code ? ` ${req.code}` : ''}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2 min-w-0 text-gray-600 dark:text-gray-300">
                    <span className="shrink-0">{formatTime(req.time)}</span>
                    {req.requestId && <span className="truncate">{t('toast.reference', { id: req.requestId })}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
        >
          {copied ? t('settings.diagnosticsCopied') : t('settings.diagnosticsCopyReport')}
        </button>
      </div>
    </SettingsSectionCard>
  );
};

export default DiagnosticsSection;
