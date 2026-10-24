import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsSectionCard, { SETTINGS_BTN_CLASSES } from '@/pages/settings/SettingsSectionCard';
import { InfoRow, InfoSubheading } from '@/components/InfoList';
import { getDiagnostics, subscribeToDiagnostics, type SSEStatus } from '@/utils/diagnostics';
import { pageDiagnosticsReport } from '@/utils/diagnosticsReport';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useServerInfo } from '@/hooks/useServerInfo';

const SSE_STATUS_KEYS: Record<SSEStatus, string> = {
  connecting: 'settings.diagnosticsSseConnecting',
  connected: 'settings.diagnosticsSseConnected',
  reconnecting: 'settings.diagnosticsSseReconnecting',
  disconnected: 'settings.diagnosticsSseDisconnected',
};

/**
 * Live-update state and recent failed requests, for a user to paste into a
 * bug report. Self-contained like `MobileAppPreference`: its state lives in
 * the diagnostics store, not in `Settings`. Build versions are shown in About;
 * the copied report carries them too, since it is read without that screen.
 */
const DiagnosticsSection = () => {
  const { t, i18n } = useTranslation();
  const diagnostics = useSyncExternalStore(subscribeToDiagnostics, getDiagnostics);
  // Not shown here (About has it), only put in the copied report.
  const serverInfo = useServerInfo();
  const { copied, copy } = useCopyToClipboard();

  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString(i18n.resolvedLanguage);
  const { sse, failedRequests } = diagnostics;

  const handleCopy = () => {
    void copy(pageDiagnosticsReport(serverInfo));
  };

  return (
    <SettingsSectionCard title={t('settings.diagnosticsSection')}>
      <div data-testid="diagnostics-section" className="space-y-5">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.diagnosticsDescription')}</p>

        <div>
          <InfoSubheading>{t('settings.diagnosticsLiveUpdates')}</InfoSubheading>
          <dl className="space-y-1">
            <InfoRow label={t('settings.diagnosticsSseStatus')} value={t(SSE_STATUS_KEYS[sse.status])} testId="diagnostics-sse-status" />
            <InfoRow label={t('settings.diagnosticsReconnectAttempts')} value={String(sse.reconnectAttempts)} testId="diagnostics-sse-attempts" />
            <InfoRow
              label={t('settings.diagnosticsLastEvent')}
              value={sse.lastEventAt ? formatTime(sse.lastEventAt) : t('settings.diagnosticsNoEvents')}
            />
          </dl>
        </div>

        <div>
          <InfoSubheading>{t('settings.diagnosticsFailedRequests', { n: failedRequests.length })}</InfoSubheading>
          {failedRequests.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.diagnosticsNoFailedRequests')}</p>
          ) : (
            // Focusable so keyboard users can scroll it.
            <ul
              tabIndex={0}
              aria-label={t('settings.diagnosticsFailedRequestsList')}
              className="max-h-64 overflow-y-auto divide-y divide-gray-200 dark:divide-slate-600 rounded-md border border-gray-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {/* Keyed by store position (oldest first), then shown newest first. */}
              {failedRequests.map((req, i) => (
                <li key={i} className="px-3 py-2 text-xs font-mono space-y-0.5">
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
              )).reverse()}
            </ul>
          )}
        </div>

        <button type="button" onClick={handleCopy} className={SETTINGS_BTN_CLASSES}>
          {copied ? t('settings.diagnosticsCopied') : t('settings.diagnosticsCopyReport')}
        </button>
      </div>
    </SettingsSectionCard>
  );
};

export default DiagnosticsSection;
