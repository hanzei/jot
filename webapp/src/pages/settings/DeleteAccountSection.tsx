import { useState } from 'react';
import type { TFunction } from 'i18next';
import DeleteAccountDialog from '@/components/DeleteAccountDialog';
import SettingsSectionCard from '@/pages/settings/SettingsSectionCard';

interface DeleteAccountSectionProps {
  t: TFunction;
  hasPassword: boolean;
  username: string;
  ssoLinked: boolean;
  /** Called after the account is deleted, to clear client auth state and leave. */
  onDeleted: () => void | Promise<void>;
}

/** The danger-zone card at the end of Settings: self-service account deletion. */
export default function DeleteAccountSection({ t, hasPassword, username, ssoLinked, onDeleted }: DeleteAccountSectionProps) {
  const [open, setOpen] = useState(false);
  // A new key per opening remounts the dialog, so it never shows the previous
  // attempt's input or error.
  const [dialogKey, setDialogKey] = useState(0);

  return (
    <SettingsSectionCard title={t('settings.deleteAccountSection')} variant="danger">
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        {t('settings.deleteAccountDescription')}
      </p>
      <button
        type="button"
        onClick={() => {
          setDialogKey(k => k + 1);
          setOpen(true);
        }}
        className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
      >
        {t('settings.deleteAccountButton')}
      </button>
      <DeleteAccountDialog
        key={dialogKey}
        open={open}
        hasPassword={hasPassword}
        username={username}
        ssoLinked={ssoLinked}
        onCancel={() => setOpen(false)}
        onDeleted={onDeleted}
      />
    </SettingsSectionCard>
  );
}
