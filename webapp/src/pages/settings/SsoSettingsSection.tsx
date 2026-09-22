import { useState } from 'react';
import type { TFunction } from 'i18next';
import SettingsSectionCard from '@/pages/settings/SettingsSectionCard';
import ConfirmDialog from '@/components/ConfirmDialog';
import { sso as ssoApi, SSO_LINK_URL, isAxiosError } from '@/utils/api';

interface SsoSettingsSectionProps {
  t: TFunction;
  providerName: string;
  /** Whether an SSO identity is currently bound to this account. */
  linked: boolean;
  /** Called after a successful unlink so the parent can refresh the user. */
  onUnlinked: () => void;
  /** Resolves a server error string that may or may not be an i18n key. */
  displayMsg: (msg: string) => string;
}

/**
 * SSO connect/disconnect controls, shown only when the server has OIDC enabled.
 *
 * Connect is a full-page navigation to the server-side link flow (an anchor,
 * not axios — the server 302s to the identity provider). Disconnect is a JSON
 * call behind a confirmation; the server may refuse it (the "don't strand the
 * account" guard when the user has no local password), and that error is
 * surfaced here rather than swallowed.
 */
export default function SsoSettingsSection({ t, providerName, linked, onUnlinked, displayMsg }: SsoSettingsSectionProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState('');

  const handleDisconnect = async () => {
    setConfirmOpen(false);
    setDisconnecting(true);
    setError('');
    try {
      await ssoApi.unlink();
      onUnlinked();
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setError(msg || 'settings.ssoDisconnectFailed');
      } else {
        setError('settings.ssoDisconnectFailed');
      }
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <SettingsSectionCard title={t('settings.ssoSection')}>
      {linked ? (
        <>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {t('settings.ssoLinkedDescription', { provider: providerName })}
          </p>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={disconnecting}
            className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-red-600 dark:text-red-400 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900 disabled:opacity-50"
          >
            {disconnecting ? t('settings.ssoDisconnecting') : t('settings.ssoDisconnect', { provider: providerName })}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {t('settings.ssoUnlinkedDescription', { provider: providerName })}
          </p>
          <a
            href={SSO_LINK_URL}
            className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
          >
            {t('settings.ssoConnect', { provider: providerName })}
          </a>
        </>
      )}

      {error && (
        <div role="alert" className="mt-4 text-red-600 dark:text-red-400 text-sm">{displayMsg(error)}</div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t('settings.ssoDisconnectConfirmTitle')}
        message={t('settings.ssoDisconnectConfirmMessage', { provider: providerName })}
        confirmLabel={t('settings.ssoDisconnect', { provider: providerName })}
        onConfirm={handleDisconnect}
        onCancel={() => setConfirmOpen(false)}
      />
    </SettingsSectionCard>
  );
}
