import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Menu } from '@headlessui/react';
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

  const profileMenu = (
    <Menu as="div" className="relative">
      <Menu.Button className="flex items-center rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800">
        {iconSrc ? (
          <img src={iconSrc} alt={displayUsername} className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <LetterAvatar firstName={currentUser?.first_name} username={baseUsername ?? ''} className="h-8 w-8" />
        )}
      </Menu.Button>
      <Menu.Items className="absolute right-0 mt-2 w-44 bg-white dark:bg-slate-800 rounded-md shadow-lg ring-1 ring-black dark:ring-slate-600 ring-opacity-5 focus:outline-none z-10 border border-gray-200 dark:border-slate-600">
        <div className="py-1">
          <Menu.Item>
            <Link
              to="/settings"
              className={`block px-4 py-2 text-sm ${settingsLinkActive ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700'}`}
              {...(settingsLinkActive ? { 'aria-current': 'page' as const } : {})}
            >
              {t('nav.settings')}
            </Link>
          </Menu.Item>
          {showAdminLink && (
            <Menu.Item>
              <Link
                to="/admin"
                className={`block px-4 py-2 text-sm ${adminLinkActive ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700'}`}
                {...(adminLinkActive ? { 'aria-current': 'page' as const } : {})}
              >
                {t('nav.admin')}
              </Link>
            </Menu.Item>
          )}
          <Menu.Item>
            <button
              onClick={onLogout}
              className="block w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-red-600 dark:hover:text-red-400"
            >
              {t('nav.logout')}
            </button>
          </Menu.Item>
        </div>
      </Menu.Items>
    </Menu>
  );

  return (
    <header className="bg-white dark:bg-slate-800 shadow-sm border-b border-gray-200 dark:border-slate-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center py-4 space-y-3 sm:space-y-0">
          {/* Top row on mobile: title left, profile icon right; left side on desktop */}
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
            {/* Profile dropdown — mobile only (right of title) */}
            <div className="sm:hidden">{profileMenu}</div>
          </div>

          {/* Children content (like search bar) */}
          {children}

          {/* Profile dropdown — desktop only (right-aligned) */}
          <div className="hidden sm:block">{profileMenu}</div>
        </div>
      </div>
    </header>
  );
};

export default NavigationHeader;
