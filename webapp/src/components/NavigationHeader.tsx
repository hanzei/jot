import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import LetterAvatar from '@/components/LetterAvatar';
import { getUser } from '@/utils/auth';

interface NavigationHeaderProps {
  title?: string;
  onLogout: () => void;
  children?: ReactNode; // For content like search bar between title and user menu
  username?: string;
  isAdmin?: boolean;
  adminLinkActive?: boolean;
  settingsLinkActive?: boolean;
}

const NavigationHeader = ({ title = 'Jot', onLogout, children, username, isAdmin: showAdminLink, adminLinkActive, settingsLinkActive }: NavigationHeaderProps) => {
  const currentUser = getUser();
  const baseUsername = username ?? currentUser?.username;
  const fullName = currentUser?.first_name || currentUser?.last_name
    ? `${currentUser.first_name} ${currentUser.last_name}`.trim()
    : null;
  const displayUsername = fullName ?? baseUsername;
  // Use updated_at as a cache-buster so the icon refreshes automatically
  // on any page after an upload or delete without needing a prop.
  const iconSrc = currentUser?.has_profile_icon
    ? `/api/v1/users/${currentUser.id}/profile-icon?v=${currentUser.updated_at}`
    : null;
  const { t } = useTranslation();

  return (
    <header className="bg-white dark:bg-slate-800 shadow-sm border-b border-gray-200 dark:border-slate-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Mobile and Desktop Layout */}
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center py-4 space-y-3 sm:space-y-0">
          {/* Top row on mobile, left side on desktop */}
          <div className="flex items-center justify-between sm:justify-start">
            <div className="flex items-center space-x-2 sm:space-x-4">
              {title === 'Jot' ? (
                <Link to="/" className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                  {title}
                </Link>
              ) : (
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
              )}
            </div>

            {/* Mobile user menu */}
            <div className="flex items-center space-x-2 sm:hidden">
              <div className="flex items-center space-x-1 text-xs text-gray-600 dark:text-gray-300">
                {iconSrc ? (
                  <img src={iconSrc} alt={displayUsername} className="h-4 w-4 rounded-full object-cover" />
                ) : (
                  <LetterAvatar firstName={currentUser?.first_name} username={baseUsername ?? ''} className="h-4 w-4" />
                )}
                <span className="max-w-16 truncate">{displayUsername}</span>
              </div>
              <Link
                to="/settings"
                className={`text-xs ${settingsLinkActive ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400'}`}
                {...(settingsLinkActive ? { 'aria-current': 'page' as const } : {})}
              >
                {t('nav.settings')}
              </Link>
              {showAdminLink && (
                <Link
                  to="/admin"
                  className={`text-xs ${adminLinkActive ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400'}`}
                  {...(adminLinkActive ? { 'aria-current': 'page' as const } : {})}
                >
                  {t('nav.admin')}
                </Link>
              )}
              <button
                onClick={onLogout}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400"
              >
                {t('nav.logout')}
              </button>
            </div>
          </div>

          {/* Children content (like search bar) */}
          {children}

          {/* Desktop user menu */}
          <div className="hidden sm:flex items-center space-x-4">
            <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300">
              {iconSrc ? (
                <img src={iconSrc} alt={displayUsername} className="h-5 w-5 rounded-full object-cover" />
              ) : (
                <LetterAvatar firstName={currentUser?.first_name} username={baseUsername ?? ''} className="h-5 w-5" />
              )}
              <span>{displayUsername}</span>
            </div>
            <Link
              to="/settings"
              className={`text-sm ${settingsLinkActive ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400'}`}
              {...(settingsLinkActive ? { 'aria-current': 'page' as const } : {})}
            >
              {t('nav.settings')}
            </Link>
            {showAdminLink && (
              <Link
                to="/admin"
                className={`text-sm ${adminLinkActive ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400'}`}
                {...(adminLinkActive ? { 'aria-current': 'page' as const } : {})}
              >
                {t('nav.admin')}
              </Link>
            )}
            <button
              onClick={onLogout}
              className="text-sm text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400"
            >
              {t('nav.logout')}
            </button>
          </div>

        </div>
      </div>
    </header>
  );
};

export default NavigationHeader;