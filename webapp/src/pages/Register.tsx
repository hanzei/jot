import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { EyeIcon, EyeSlashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { auth } from '@/utils/api';
import { setUser, setSettings } from '@/utils/auth';
import { getUsernameValidationError, isPasswordTooShort } from '@/utils/userValidation';
import { VALIDATION } from '@jot/shared';

interface RegisterProps {
  onRegister: () => void;
  passwordMinLength: number;
}

export default function Register({ onRegister, passwordMinLength }: RegisterProps) {
  const { t } = useTranslation();
  useEffect(() => { document.title = t('pageTitle.register'); }, [t]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const usernameValidationErrorTranslations = {
    min: t('auth.usernameMin'),
    max: t('auth.usernameMax'),
    chars: t('auth.usernameChars'),
    edge: t('auth.usernameEdge'),
  } as const;
  const usernameValidationError = username ? getUsernameValidationError(username) : null;
  const usernameValidationMessage = usernameValidationError
    ? usernameValidationErrorTranslations[usernameValidationError]
    : null;
  const passwordTooShort = password.length > 0 && isPasswordTooShort(password, passwordMinLength);
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const usernameMessageId = 'register-username-message';
  const passwordMessageId = 'register-password-message';
  const confirmPasswordMessageId = 'register-confirm-password-message';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const usernameValidationError = getUsernameValidationError(username);
    if (usernameValidationError) {
      setError(usernameValidationErrorTranslations[usernameValidationError]);
      setLoading(false);
      return;
    }

    if (password !== confirmPassword) {
      setError(t('auth.passwordsNoMatch'));
      setLoading(false);
      return;
    }

    if (isPasswordTooShort(password, passwordMinLength)) {
      setError(t('auth.passwordMin', { min: passwordMinLength }));
      setLoading(false);
      return;
    }

    try {
      const response = await auth.register({ username, password });
      setUser(response.user);
      setSettings(response.settings);
      onRegister();
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: string } };
      setError(axiosError.response?.data || t('auth.registrationFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-slate-900">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-gray-200 dark:bg-slate-800 dark:ring-slate-700">
            <img src="/icon.svg" alt={t('auth.logoAlt')} className="h-9 w-9" />
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
            {t('auth.createAccountTitle')}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-300">
            {t('auth.or')}{' '}
            <Link
              to="/login"
              className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300"
            >
              {t('auth.signInExistingAccount')}
            </Link>
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-sm space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('auth.usernamePlaceholder')}
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoCapitalize="none"
                autoComplete="username"
                required
                aria-invalid={usernameValidationMessage ? 'true' : 'false'}
                aria-describedby={usernameMessageId}
                className={`mt-1 appearance-none relative block w-full px-3 py-2 border placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white bg-white dark:bg-slate-700 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm ${
                  usernameValidationMessage
                    ? 'border-red-300 dark:border-red-600'
                    : 'border-gray-300 dark:border-slate-600'
                }`}
                placeholder={t('auth.usernamePlaceholderLong')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <div className="mt-1 flex items-center justify-between text-xs">
                <p id={usernameMessageId} className={usernameValidationMessage ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}>
                  {usernameValidationMessage || t('auth.usernamePlaceholderLong')}
                </p>
                <span className={username.length > VALIDATION.USERNAME_MAX_LENGTH ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}>
                  {username.length}/{VALIDATION.USERNAME_MAX_LENGTH}
                </span>
              </div>
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('auth.passwordPlaceholder')}
              </label>
              <div className="relative mt-1">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  aria-invalid={passwordTooShort ? 'true' : 'false'}
                  aria-describedby={passwordMessageId}
                  className={`appearance-none relative block w-full px-3 py-2 pr-10 border placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white bg-white dark:bg-slate-700 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm ${
                    passwordTooShort
                      ? 'border-red-300 dark:border-red-600'
                      : 'border-gray-300 dark:border-slate-600'
                  }`}
                  placeholder={t('auth.passwordPlaceholderLong', { min: passwordMinLength })}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  className="absolute inset-y-0 right-0 z-10 flex items-center px-3 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-700 rounded-r-md"
                  aria-pressed={showPassword}
                  aria-label={showPassword
                    ? `${t('auth.hidePassword')} (${t('auth.passwordPlaceholder')})`
                    : `${t('auth.showPassword')} (${t('auth.passwordPlaceholder')})`}
                >
                  {showPassword ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
                </button>
              </div>
              <p id={passwordMessageId} className={`mt-1 text-xs ${passwordTooShort ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                {passwordTooShort
                  ? t('auth.passwordMin', { min: passwordMinLength })
                  : t('auth.passwordHint', { min: passwordMinLength })}
              </p>
            </div>
            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('auth.confirmPasswordPlaceholder')}
              </label>
              <div className="relative mt-1">
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  aria-invalid={passwordsMismatch ? 'true' : 'false'}
                  aria-describedby={passwordsMismatch ? confirmPasswordMessageId : undefined}
                  className={`appearance-none relative block w-full px-3 py-2 pr-10 border placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white bg-white dark:bg-slate-700 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm ${
                    passwordsMismatch
                      ? 'border-red-300 dark:border-red-600'
                      : 'border-gray-300 dark:border-slate-600'
                  }`}
                  placeholder={t('auth.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((current) => !current)}
                  className="absolute inset-y-0 right-0 z-10 flex items-center px-3 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-700 rounded-r-md"
                  aria-pressed={showConfirmPassword}
                  aria-label={showConfirmPassword
                    ? `${t('auth.hidePassword')} (${t('auth.confirmPasswordPlaceholder')})`
                    : `${t('auth.showPassword')} (${t('auth.confirmPasswordPlaceholder')})`}
                >
                  {showConfirmPassword ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
                </button>
              </div>
              {passwordsMismatch && (
                <p id={confirmPasswordMessageId} className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {t('auth.passwordsNoMatch')}
                </p>
              )}
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
            >
              <div className="flex items-start gap-2">
                <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? t('auth.creatingAccount') : t('auth.createAccount')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}