import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Info, TriangleAlert } from 'lucide-react';
import type { SSOConfig } from '@jot/shared';
import { auth, SSO_LOGIN_URL } from '@/utils/api';
import { setUser, setSettings } from '@/utils/auth';
import { REDIRECT_PARAM, authPathWithRedirect } from '@/utils/authRedirect';
import { ssoLoginErrorMessage, useSsoErrorParam } from '@/utils/ssoError';

interface LoginProps {
  onLogin: () => void;
  registrationEnabled: boolean;
  sso: SSOConfig;
}

export default function Login({ onLogin, registrationEnabled, sso }: LoginProps) {
  const { t } = useTranslation();
  useEffect(() => { document.title = t('pageTitle.login'); }, [t]);
  const [searchParams] = useSearchParams();
  // Where the user was headed before being bounced here, if anywhere. Carried
  // over to the registration link; the redirect itself is the router's job
  // (see PostAuthRedirect), which is what runs once onLogin flips this route.
  const continueTo = searchParams.get(REDIRECT_PARAM);
  // A failed SSO sign-in lands back here with the reason (see the server's
  // OIDC callback).
  const ssoErrorCode = useSsoErrorParam();
  const ssoError = ssoErrorCode === null ? null : ssoLoginErrorMessage(ssoErrorCode);

  // With SSO enabled and local login turned off, the password form and the
  // register link disappear entirely — SSO becomes the only way in. A pre-SSO
  // or SSO-disabled server keeps local login on, so the page is unchanged.
  const showLocalLogin = !sso.enabled || sso.local_login_enabled;
  // The server defaults an unset provider name to "SSO"; fall back defensively.
  const providerName = sso.provider_name || 'SSO';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await auth.login({ username, password });
      setUser(response.user);
      setSettings(response.settings);
      onLogin();
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: string } };
      setError(axiosError.response?.data || t('auth.loginFailed'));
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
            {t('auth.signInTitle')}
          </h2>
          {showLocalLogin && registrationEnabled && (
            <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-300">
              {t('auth.or')}{' '}
              <Link
                to={authPathWithRedirect('/register', continueTo)}
                className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300"
              >
                {t('auth.createNewAccount')}
              </Link>
            </p>
          )}
        </div>

        {ssoError && (ssoError.cancelled ? (
          <div
            role="status"
            className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-200"
          >
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-500 dark:text-blue-400" />
              <span>{t(ssoError.key)}</span>
            </div>
          </div>
        ) : (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <span>{t(ssoError.key)}</span>
            </div>
          </div>
        ))}

        {sso.enabled && (
          <div className="mt-8 space-y-6">
            {/*
              A full-page navigation, not an axios call: the server 302s to the
              identity provider, so the browser has to leave the SPA. An anchor
              does exactly that and stays keyboard/screen-reader accessible.
            */}
            <a
              href={SSO_LOGIN_URL}
              className="group relative w-full flex justify-center py-2 px-4 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900"
            >
              {t('auth.ssoSignInWith', { provider: providerName })}
            </a>

            {showLocalLogin && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center" aria-hidden="true">
                  <div className="w-full border-t border-gray-300 dark:border-slate-600" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-gray-50 dark:bg-slate-900 px-2 text-gray-500 dark:text-gray-400">
                    {t('auth.ssoDivider')}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {showLocalLogin && (
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="username" className="sr-only">
                {t('auth.usernamePlaceholder')}
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoCapitalize="none"
                autoComplete="username"
                required
                className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 dark:border-slate-600 placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white bg-white dark:bg-slate-700 rounded-t-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm"
                placeholder={t('auth.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">
                {t('auth.passwordPlaceholder')}
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 pr-10 border border-gray-300 dark:border-slate-600 placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white bg-white dark:bg-slate-700 rounded-b-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  placeholder={t('auth.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 z-10 flex items-center rounded-r-md px-3 text-gray-500 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:text-gray-400 dark:hover:text-gray-200 dark:focus-visible:ring-offset-slate-700"
                  aria-label={showPassword
                    ? `${t('auth.hidePassword')} (${t('auth.passwordPlaceholder')})`
                    : `${t('auth.showPassword')} (${t('auth.passwordPlaceholder')})`}
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400 animate-fade-in motion-reduce:animate-none"
            >
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-5 w-5 flex-shrink-0" />
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
              {loading ? t('auth.signingIn') : t('auth.signIn')}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}