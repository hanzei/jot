import { useState, useEffect, useMemo } from 'react';
import { Dialog } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { about } from '@/utils/api';
import { getUser } from '@/utils/auth';
import { AboutInfo } from '@/types';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  const { t, i18n } = useTranslation();
  const user = useMemo(() => getUser(), []);
  const [serverInfo, setServerInfo] = useState<AboutInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    setError('');
    about.get()
      .then(info => { if (!cancelled) setServerInfo(info); })
      .catch(() => { if (!cancelled) setError(t('about.failedLoad')); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, t]);

  const handleClose = () => {
    setServerInfo(null);
    setError('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/25" />

      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-sm w-full rounded bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <Dialog.Title className="text-lg font-medium text-gray-900 dark:text-white">
                {t('about.title')}
              </Dialog.Title>
              <button
                onClick={handleClose}
                aria-label={t('common.close')}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                  {t('about.clientInfo')}
                </h3>
                <dl className="space-y-1">
                  <div className="flex justify-between text-sm min-w-0 gap-2">
                    <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.username')}</dt>
                    <dd className="truncate text-gray-900 dark:text-white font-mono">{user?.username ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between text-sm min-w-0 gap-2">
                    <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.userId')}</dt>
                    <dd className="truncate text-gray-900 dark:text-white font-mono">{user?.id ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between text-sm min-w-0 gap-2">
                    <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.role')}</dt>
                    <dd className="truncate text-gray-900 dark:text-white font-mono">{user?.role ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between text-sm min-w-0 gap-2">
                    <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.accountCreated')}</dt>
                    <dd className="truncate text-gray-900 dark:text-white font-mono">
                      {user?.created_at ? new Date(user.created_at).toLocaleDateString(i18n.resolvedLanguage) : '—'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="border-t border-gray-200 dark:border-slate-700 pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                  {t('about.serverInfo')}
                </h3>
                {isLoading && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('about.loading')}</p>
                )}
                {error && (
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                )}
                {serverInfo && (
                  <dl className="space-y-1">
                    <div className="flex justify-between text-sm min-w-0 gap-2">
                      <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.appVersion')}</dt>
                      <dd className="truncate text-gray-900 dark:text-white font-mono">{serverInfo.version}</dd>
                    </div>
                    <div className="flex justify-between text-sm min-w-0 gap-2">
                      <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.commit')}</dt>
                      <dd className="truncate text-gray-900 dark:text-white font-mono">{serverInfo.commit}</dd>
                    </div>
                    {serverInfo.build_time && (
                      <div className="flex justify-between text-sm min-w-0 gap-2">
                        <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.buildTime')}</dt>
                        <dd className="truncate text-gray-900 dark:text-white font-mono">
                          {(() => { const dt = new Date(serverInfo.build_time!); return isNaN(dt.getTime()) ? '—' : dt.toLocaleString(i18n.resolvedLanguage); })()}
                        </dd>
                      </div>
                    )}
                    {serverInfo.go_version && (
                      <div className="flex justify-between text-sm min-w-0 gap-2">
                        <dt className="shrink-0 text-gray-500 dark:text-gray-400">{t('about.goVersion')}</dt>
                        <dd className="truncate text-gray-900 dark:text-white font-mono">{serverInfo.go_version}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
            </div>
          </Dialog.Panel>
        </div>
      </div>
    </Dialog>
  );
}
