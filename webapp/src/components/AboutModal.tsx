import { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { about } from '@/utils/api';
import { getUser } from '@/utils/auth';
import { WEBAPP_BUILD } from '@/utils/buildInfo';
import { InfoRow, InfoSubheading } from '@/components/InfoList';
import type { AboutInfo } from '@jot/shared';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** A server build time for display, or '—' when it does not parse. */
function formatBuildTime(iso: string, locale: string | undefined): string {
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleString(locale);
}

export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  const { t, i18n } = useTranslation();
  const user = useMemo(() => getUser(), []);
  const [serverInfo, setServerInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState('');

  // Derived: loading while the modal is open but we have no result yet.
  const isLoading = isOpen && serverInfo === null && error === '';

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    about.get()
      .then(info => { if (!cancelled) setServerInfo(info); })
      .catch(() => { if (!cancelled) setError(t('about.failedLoad')); });
    return () => { cancelled = true; };
  }, [isOpen, t]);

  const handleClose = () => {
    setServerInfo(null);
    setError('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      <DialogBackdrop transition className="fixed inset-0 bg-black/25 transition duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />

      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel transition className="mx-auto max-w-sm w-full rounded bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700 transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none">
            <div className="flex items-center justify-between mb-4">
              <DialogTitle className="text-lg font-medium text-gray-900 dark:text-white">
                {t('about.title')}
              </DialogTitle>
              <button
                onClick={handleClose}
                aria-label={t('common.close')}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <InfoSubheading>{t('about.clientInfo')}</InfoSubheading>
                <dl className="space-y-1">
                  <InfoRow label={t('about.username')} value={user?.username ?? '—'} />
                  <InfoRow label={t('about.userId')} value={user?.id ?? '—'} />
                  <InfoRow label={t('about.role')} value={user?.role ?? '—'} />
                  <InfoRow
                    label={t('about.accountCreated')}
                    value={user?.created_at ? new Date(user.created_at).toLocaleDateString(i18n.resolvedLanguage) : '—'}
                  />
                  {/* This bundle's own build. It can trail the server's below
                      while the service worker still serves a cached bundle. */}
                  <InfoRow label={t('about.appVersion')} value={WEBAPP_BUILD.version} testId="about-webapp-version" />
                  <InfoRow label={t('about.commit')} value={WEBAPP_BUILD.commit ?? '—'} testId="about-webapp-commit" />
                </dl>
              </div>

              <div className="border-t border-gray-200 dark:border-slate-700 pt-4">
                <InfoSubheading>{t('about.serverInfo')}</InfoSubheading>
                {isLoading && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('about.loading')}</p>
                )}
                {error && (
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                )}
                {serverInfo && (
                  <dl className="space-y-1">
                    <InfoRow label={t('about.appVersion')} value={serverInfo.version} />
                    <InfoRow label={t('about.commit')} value={serverInfo.commit} />
                    {serverInfo.build_time && (
                      <InfoRow label={t('about.buildTime')} value={formatBuildTime(serverInfo.build_time, i18n.resolvedLanguage)} />
                    )}
                    {serverInfo.go_version && (
                      <InfoRow label={t('about.goVersion')} value={serverInfo.go_version} />
                    )}
                  </dl>
                )}
              </div>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
