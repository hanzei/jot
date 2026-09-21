import { useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { X, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isPasswordTooShort, type User } from '@jot/shared';
import { admin, isAxiosError } from '@/utils/api';

interface ResetPasswordModalProps {
  user: User;
  passwordMinLength: number;
  onClose: () => void;
  onSuccess: (user: User) => void;
}

// Baseline length for generated passwords; the actual length is raised to the
// server's configured minimum when that is longer, so a generated password
// always satisfies validation.
const GENERATED_PASSWORD_LENGTH = 24;

// generatePassword returns a cryptographically random alphanumeric password of
// the given length using the Web Crypto API, with rejection sampling to avoid
// modulo bias.
function generatePassword(length: number): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const maxByte = 256 - (256 % chars.length);
  const result: string[] = [];
  const buf = new Uint8Array(1);
  while (result.length < length) {
    crypto.getRandomValues(buf);
    const byte = buf[0]!;
    if (byte < maxByte) {
      result.push(chars[byte % chars.length]!);
    }
  }
  return result.join('');
}

export default function ResetPasswordModal({ user, passwordMinLength, onClose, onSuccess }: ResetPasswordModalProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState('');

  const displayName = user.first_name || user.last_name
    ? `${user.first_name} ${user.last_name}`.trim()
    : user.username;

  const validatePassword = (value: string): string => {
    if (isPasswordTooShort(value, passwordMinLength)) {
      return t('admin.passwordMin', { min: passwordMinLength });
    }
    return '';
  };

  const passwordValidationError = validatePassword(password);
  const passwordFieldError = (touched || showValidationErrors) ? passwordValidationError : '';
  const hasBlockingValidationErrors = Boolean(passwordFieldError);

  const handleGenerate = () => {
    setPassword(generatePassword(Math.max(GENERATED_PASSWORD_LENGTH, passwordMinLength)));
    setShowPassword(true);
    setTouched(true);
    if (error) setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setShowValidationErrors(true);
    setTouched(true);

    if (passwordValidationError) return;

    setLoading(true);
    try {
      await admin.setUserPassword(user.id, { new_password: password });
      onSuccess(user);
      onClose();
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setError(msg || t('admin.failedResetPassword'));
      } else {
        setError(t('admin.failedResetPassword'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onClose={loading ? () => {} : onClose} className="relative z-50">
      <DialogBackdrop transition aria-hidden="true" className="fixed inset-0 bg-black/25 dark:bg-black/50 transition duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel transition className="mx-auto w-full max-w-md rounded-lg bg-white dark:bg-slate-800 shadow-xl border border-gray-200 dark:border-slate-700 transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none">
            <div className="flex items-center justify-between p-6 pb-4">
              <DialogTitle className="text-lg font-medium text-gray-900 dark:text-white">
                {t('admin.resetPasswordTitle')}
              </DialogTitle>
              <button
                onClick={onClose}
                disabled={loading}
                aria-label={t('common.close')}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="px-6 pb-4 space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('admin.resetPasswordDescription', { name: displayName })}
                </p>

                <div>
                  <label htmlFor="reset-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.newPasswordLabel')}
                  </label>
                  <div className="mt-1 flex gap-2">
                    <div className="relative flex-1">
                      <input
                        id="reset-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={passwordMinLength}
                        value={password}
                        onBlur={() => setTouched(true)}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          if (error) setError('');
                        }}
                        className={`block w-full border rounded-md px-3 py-2 pr-10 text-sm bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 ${
                          passwordFieldError
                            ? 'border-red-300 dark:border-red-600'
                            : 'border-gray-300 dark:border-slate-600'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(prev => !prev)}
                        aria-label={showPassword ? t('admin.hidePassword') : t('admin.showPassword')}
                        className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleGenerate}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-600"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      {t('admin.generatePassword')}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.resetPasswordHint', { min: passwordMinLength })}
                  </p>
                  {passwordFieldError && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">{passwordFieldError}</p>
                  )}
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
                  {loading ? t('admin.resettingPassword') : t('admin.resetPasswordButton')}
                </button>
              </div>
            </form>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
