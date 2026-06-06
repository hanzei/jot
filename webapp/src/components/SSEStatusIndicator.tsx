import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SSEStatus } from '../hooks/useSSE';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

// Wait this long before surfacing a non-connected state so brief, self-healing
// reconnects (e.g. a tab waking from sleep) don't flash the indicator.
const SHOW_DELAY_MS = 2000;

interface SSEStatusIndicatorProps {
  status: SSEStatus;
}

export function SSEStatusIndicator({ status }: SSEStatusIndicatorProps) {
  const { t } = useTranslation();
  const isOnline = useOnlineStatus();
  // `armed` flips true once the interruption has lasted SHOW_DELAY_MS. It is
  // only ever set inside async callbacks (the timeout and its cleanup) so the
  // effect body stays free of synchronous setState.
  const [armed, setArmed] = useState(false);

  const interrupted = status !== 'connected';

  useEffect(() => {
    if (!interrupted) {
      return;
    }
    const timer = setTimeout(() => setArmed(true), SHOW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setArmed(false);
    };
  }, [interrupted]);

  // When the browser itself is offline, OfflineNotification already tells the
  // user; don't stack a second, redundant indicator on top of it.
  if (!interrupted || !armed || !isOnline) {
    return null;
  }

  // A spinner while the browser is still trying (first connect or retrying);
  // a warning icon once it has given up.
  const inProgress = status === 'connecting' || status === 'reconnecting';
  const message = status === 'connecting' ? t('sse.connecting')
    : status === 'reconnecting' ? t('sse.reconnecting')
    : t('sse.disconnected');

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sse-status-indicator"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-slate-800 dark:bg-slate-700 text-white px-3 py-2 text-sm shadow-lg"
    >
      {inProgress ? (
        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )}
      <span>{message}</span>
    </div>
  );
}
