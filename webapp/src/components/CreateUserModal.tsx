import { useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { PASSWORD_MIN_LENGTH, ROLES, VALIDATION, type User, type CreateUserRequest } from '@jot/shared';
import { admin, isAxiosError } from '@/utils/api';
import { getUsernameValidationError, isPasswordTooShort } from '@/utils/userValidation';

interface CreateUserModalProps {
  onClose: () => void;
  onSuccess: (user: User) => void;
}

type CreateUserField = 'username' | 'password';

export default function CreateUserModal({ onClose, onSuccess }: CreateUserModalProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState<Record<CreateUserField, boolean>>({ username: false, password: false });
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [formData, setFormData] = useState<CreateUserRequest>({
    username: '',
    password: '',
    role: ROLES.USER,
  });

  const validateUsername = (username: string): string => {
    const errorCode = getUsernameValidationError(username);
    if (!errorCode) return '';
    const translationKeyByError = {
      min: 'admin.usernameMin',
      max: 'admin.usernameMax',
      chars: 'admin.usernameChars',
      edge: 'admin.usernameEdge',
    } as const;
    return t(translationKeyByError[errorCode], {
      min: VALIDATION.USERNAME_MIN_LENGTH,
      max: VALIDATION.USERNAME_MAX_LENGTH,
    });
  };

  const validatePassword = (password: string): string => {
    if (isPasswordTooShort(password)) {
      return t('admin.passwordMin', { min: PASSWORD_MIN_LENGTH });
    }
    return '';
  };

  const usernameValidationError = validateUsername(formData.username);
  const passwordValidationError = validatePassword(formData.password);
  const hasValidationErrors = Boolean(usernameValidationError || passwordValidationError);
  const usernameFieldError = (touched.username || showValidationErrors) ? usernameValidationError : '';
  const passwordFieldError = (touched.password || showValidationErrors) ? passwordValidationError : '';
  const hasBlockingValidationErrors = Boolean(
    (touched.username && usernameValidationError) ||
    (touched.password && passwordValidationError) ||
    (showValidationErrors && hasValidationErrors),
  );

  const handleFieldBlur = (field: CreateUserField) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setShowValidationErrors(true);
    setTouched({ username: true, password: true });

    if (hasValidationErrors) return;

    setLoading(true);
    try {
      const newUser = await admin.createUser(formData);
      onSuccess(newUser);
      onClose();
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setError(msg || t('admin.failedCreateUser'));
      } else {
        setError(t('admin.failedCreateUser'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onClose={loading ? () => {} : onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/25 dark:bg-black/50" aria-hidden="true" />
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel className="mx-auto w-full max-w-md rounded-lg bg-white dark:bg-slate-800 shadow-xl border border-gray-200 dark:border-slate-700">
            <div className="flex items-center justify-between p-6 pb-4">
              <DialogTitle className="text-lg font-medium text-gray-900 dark:text-white">
                {t('admin.createNewUser')}
              </DialogTitle>
              <button
                onClick={onClose}
                disabled={loading}
                aria-label={t('common.close')}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="px-6 pb-4 space-y-4">
                <div>
                  <label htmlFor="create-username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.usernameLabel')}
                  </label>
                  <input
                    id="create-username"
                    type="text"
                    required
                    value={formData.username}
                    onBlur={() => handleFieldBlur('username')}
                    onChange={(e) => {
                      setFormData({ ...formData, username: e.target.value });
                      if (error) setError('');
                    }}
                    className={`mt-1 block w-full border rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 ${
                      usernameFieldError
                        ? 'border-red-300 dark:border-red-600'
                        : 'border-gray-300 dark:border-slate-600'
                    }`}
                    placeholder={t('admin.usernamePlaceholder')}
                  />
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <p className="text-gray-500 dark:text-gray-400">
                      {t('admin.usernameHint', {
                        min: VALIDATION.USERNAME_MIN_LENGTH,
                        max: VALIDATION.USERNAME_MAX_LENGTH,
                      })}
                    </p>
                    <span
                      className={formData.username.length > VALIDATION.USERNAME_MAX_LENGTH
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-500 dark:text-gray-400'}
                    >
                      {t('admin.usernameCharacterCount', {
                        current: formData.username.length,
                        max: VALIDATION.USERNAME_MAX_LENGTH,
                      })}
                    </span>
                  </div>
                  {usernameFieldError && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">{usernameFieldError}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="create-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.passwordLabel')}
                  </label>
                  <input
                    id="create-password"
                    type="password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    value={formData.password}
                    onBlur={() => handleFieldBlur('password')}
                    onChange={(e) => {
                      setFormData({ ...formData, password: e.target.value });
                      if (error) setError('');
                    }}
                    className={`mt-1 block w-full border rounded-md px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 ${
                      passwordFieldError
                        ? 'border-red-300 dark:border-red-600'
                        : 'border-gray-300 dark:border-slate-600'
                    }`}
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.passwordHint', { min: PASSWORD_MIN_LENGTH })}
                  </p>
                  {passwordFieldError && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">{passwordFieldError}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="create-admin-role" className="flex items-center">
                    <input
                      id="create-admin-role"
                      type="checkbox"
                      checked={formData.role === ROLES.ADMIN}
                      onChange={(e) => setFormData({ ...formData, role: e.target.checked ? ROLES.ADMIN : ROLES.USER })}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{t('admin.adminUser')}</span>
                  </label>
                </div>

                {error && (
                  <div role="alert" className="text-red-600 dark:text-red-400 text-sm">{error}</div>
                )}
              </div>

              <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200 dark:border-slate-700">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50"
                >
                  {t('admin.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={loading || hasBlockingValidationErrors}
                  className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-400 dark:disabled:bg-blue-500 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-sm font-medium"
                >
                  {loading ? t('admin.creating') : t('admin.createUserButton')}
                </button>
              </div>
            </form>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
