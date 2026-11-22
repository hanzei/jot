import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudOff } from 'lucide-react';

/**
 * Shown instead of the login page when the session check got no answer from
 * the server and this device has no signed-in user to fall back on. A login
 * form could not work either, and would wrongly suggest the user was signed out.
 * Retrying reloads, which runs the whole startup check again.
 */
export default function ServerUnreachable() {
  const { t } = useTranslation();
  useEffect(() => { document.title = t('serverUnreachable.title'); }, [t]);

  return (
    <main className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-slate-900">
      <div className="max-w-md w-full space-y-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-gray-200 dark:bg-slate-800 dark:ring-slate-700">
          <CloudOff className="h-8 w-8 text-gray-500 dark:text-gray-400" aria-hidden="true" />
        </div>
        <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white">
          {t('serverUnreachable.title')}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t('serverUnreachable.message')}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
        >
          {t('serverUnreachable.retry')}
        </button>
      </div>
    </main>
  );
}
