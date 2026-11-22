import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { endServerSession } from '@/utils/logout';

interface PendingLogoutNoticeProps {
  /** The retry reached the server and the session is over. */
  onEnded: () => void;
}

/**
 * Shown on the login page after a sign-out whose `POST /logout` failed. The
 * device has forgotten the user, but the HttpOnly session cookie is still
 * valid and only the server can clear it, so a reload would sign them back in.
 */
export default function PendingLogoutNotice({ onEnded }: PendingLogoutNoticeProps) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);

  const retry = async () => {
    setRetrying(true);
    const ended = await endServerSession();
    setRetrying(false);
    if (ended) {
      onEnded();
    } else {
      setRetryFailed(true);
    }
  };

  return (
    <div
      role="alert"
      data-testid="pending-logout-notice"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden="true" />
        <div className="space-y-2">
          <p>{t('auth.logoutPending.message')}</p>
          {retryFailed && <p>{t('auth.logoutPending.retryFailed')}</p>}
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            className="rounded-md border border-amber-400 bg-white px-3 py-1 font-medium text-amber-900 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed dark:border-amber-600 dark:bg-slate-800 dark:text-amber-200 dark:hover:bg-slate-700"
          >
            {retrying ? t('auth.logoutPending.retrying') : t('auth.logoutPending.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}
