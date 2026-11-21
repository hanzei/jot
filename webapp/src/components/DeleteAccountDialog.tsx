import { useId, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseApiError } from '@jot/shared';
import { users } from '@/utils/api';
import { apiErrorMessage } from '@/utils/apiError';

interface DeleteAccountDialogProps {
  open: boolean;
  /**
   * Whether the account has a password. With one, the user confirms by typing
   * it; without (an SSO-only account) they type their username instead.
   */
  hasPassword: boolean;
  /** Shown in the username prompt of an account without a password. */
  username: string;
  /** Adds the note that signing in with SSO again creates a new, empty account. */
  ssoLinked: boolean;
  onCancel: () => void;
  /** Called after the server deleted the account (and cleared the session cookie). */
  onDeleted: () => void | Promise<void>;
}

/**
 * Confirms `DELETE /users/me`. Like `ConfirmDialog` in structure and styling,
 * plus the field the server re-checks: the current password, or the username
 * on an account without one. Render it with a fresh `key` per opening so a
 * reopened dialog starts empty.
 */
export default function DeleteAccountDialog({
  open,
  hasPassword,
  username,
  ssoLinked,
  onCancel,
  onDeleted,
}: DeleteAccountDialogProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const fieldErrorId = useId();
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [formError, setFormError] = useState('');
  const [lastAdmin, setLastAdmin] = useState(false);

  const filled = hasPassword ? value !== '' : value.trim() !== '';

  const handleConfirm = async () => {
    if (isSubmitting || !filled) return;
    setIsSubmitting(true);
    setFieldError('');
    setFormError('');
    setLastAdmin(false);
    try {
      await users.deleteMe(hasPassword ? { current_password: value } : { username: value.trim() });
    } catch (err: unknown) {
      const code = parseApiError(err)?.code;
      if (code === 'incorrect_password' || code === 'incorrect_username') {
        setFieldError(apiErrorMessage(err, t, 'settings.deleteAccountFailed'));
      } else if (code === 'last_admin') {
        setLastAdmin(true);
      } else {
        setFormError(apiErrorMessage(err, t, 'settings.deleteAccountFailed'));
      }
      setIsSubmitting(false);
      return;
    }
    // The account is gone: stay in the pending state while the caller signs out.
    await onDeleted();
  };

  return (
    <Dialog
      open={open}
      onClose={isSubmitting ? () => {} : onCancel}
      className="relative z-[60]"
      onKeyDown={(e) => {
        // See ConfirmDialog: stop portaled key events reaching parent listeners,
        // and handle Escape here since that also stops headlessui's own.
        e.stopPropagation();
        if (e.key === 'Escape' && !isSubmitting) {
          onCancel();
        }
      }}
    >
      <DialogBackdrop transition aria-hidden="true" className="fixed inset-0 bg-black/30 dark:bg-black/50 transition duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel transition className="mx-auto w-full max-w-md rounded-lg bg-white dark:bg-slate-800 shadow-xl border border-gray-200 dark:border-slate-700 max-h-[90vh] overflow-y-auto scrollbar-subtle transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none">
          <form onSubmit={(e) => { e.preventDefault(); void handleConfirm(); }}>
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 rounded-full bg-red-100 dark:bg-red-900/30 p-2">
                  <TriangleAlert className="h-5 w-5 text-red-600 dark:text-red-400" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-base font-semibold text-gray-900 dark:text-white">
                    {t('settings.deleteAccountConfirmTitle')}
                  </DialogTitle>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-300">
                    <li>{t('settings.deleteAccountWhatIsDeleted')}</li>
                    <li>{t('settings.deleteAccountSharedWithYou')}</li>
                    {ssoLinked && <li>{t('settings.deleteAccountSsoNote')}</li>}
                  </ul>
                  <p className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                    {t('settings.deleteAccountIrreversible')}
                  </p>

                  <div className="mt-4">
                    <label htmlFor={fieldId} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {hasPassword
                        ? t('settings.currentPasswordLabel')
                        : t('settings.deleteAccountUsernameLabel', { username })}
                    </label>
                    <input
                      id={fieldId}
                      data-autofocus
                      type={hasPassword ? 'password' : 'text'}
                      autoComplete={hasPassword ? 'current-password' : 'off'}
                      autoCapitalize="none"
                      spellCheck={false}
                      value={value}
                      disabled={isSubmitting}
                      onChange={(e) => {
                        setValue(e.target.value);
                        setFieldError('');
                      }}
                      aria-invalid={fieldError ? true : undefined}
                      aria-describedby={fieldError ? fieldErrorId : undefined}
                      className="mt-1 block w-full border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                    />
                    {fieldError && (
                      <p id={fieldErrorId} role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
                        {fieldError}
                      </p>
                    )}
                  </div>

                  {lastAdmin && (
                    <div role="alert" data-testid="delete-account-last-admin" className="mt-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-100">
                      <p className="font-medium">{t('settings.deleteAccountLastAdminTitle')}</p>
                      <p className="mt-1">{t('settings.deleteAccountLastAdminMessage')}</p>
                    </div>
                  )}
                  {formError && (
                    <div role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
                      {formError}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200 dark:border-slate-700">
              <button
                type="button"
                onClick={onCancel}
                disabled={isSubmitting}
                className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800 disabled:opacity-50"
              >
                {t('import.cancelButton')}
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !filled}
                aria-busy={isSubmitting || undefined}
                className="px-3 py-2 text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 dark:focus:ring-offset-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? t('settings.deleteAccountDeleting') : t('settings.deleteAccountConfirmButton')}
              </button>
            </div>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
