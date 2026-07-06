import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, CloudOff } from 'lucide-react';
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
      className="w-full bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 px-4 py-2 text-sm flex items-center justify-center gap-2"
    >
      {inProgress ? (
        <LoaderCircle className="w-4 h-4 animate-spin" />
      ) : (
        <CloudOff className="w-4 h-4" />
      )}
      <span>{message}</span>
    </div>
  );
}
