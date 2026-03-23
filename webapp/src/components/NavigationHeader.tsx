import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Bars3Icon } from '@heroicons/react/24/outline';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import LetterAvatar from '@/components/LetterAvatar';
import ConfirmDialog from '@/components/ConfirmDialog';
import { getUser } from '@/utils/auth';
import { buildMobileDeepLink } from '@/utils/deepLink';
import { dismissMobileAppBanner, isMobileAppBannerDismissed } from '@/utils/mobileAppBanner';

interface NavigationHeaderProps {
  title?: string;
  onLogout: () => void;
  children?: ReactNode; // For content like search bar between title and user menu
  username?: string;
  isAdmin?: boolean;
  adminLinkActive?: boolean;
  settingsLinkActive?: boolean;
  onToggleSidebar?: () => void;
}

interface ProfileMenuProps {
  iconSrc: string | null;
  displayUsername: string | undefined;
  firstName: string | undefined;
  baseUsername: string;
  showAdminLink: boolean | undefined;
  adminLinkActive: boolean | undefined;
  settingsLinkActive: boolean | undefined;
  onLogout: () => void;
}

const ProfileMenu = ({ iconSrc, displayUsername, firstName, baseUsername, showAdminLink, adminLinkActive, settingsLinkActive, onLogout }: ProfileMenuProps) => {
  const { t } = useTranslation();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  return (
    <div className="relative">
      <Menu>
        <MenuButton
          title={displayUsername}
          aria-label={t('nav.profileMenu')}
          className="flex items-center rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
        >
          {iconSrc ? (
            <img src={iconSrc} alt={displayUsername} className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <LetterAvatar firstName={firstName} username={baseUsername} className="h-8 w-8" />
          )}
        </MenuButton>
        <MenuItems className="absolute right-0 mt-2 w-44 bg-white dark:bg-slate-800 rounded-md shadow-lg ring-1 ring-black/5 dark:ring-slate-600/20 focus:outline-none z-10 border border-gray-200 dark:border-slate-600">
          <div className="py-1">
            <MenuItem>
              <Link
                to="/settings"
                className={`block px-4 py-2 text-sm data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700 ${
                  settingsLinkActive
                    ? 'text-blue-600 dark:text-blue-400 font-medium'
                    : 'text-gray-700 dark:text-gray-200'
                }`}
                {...(settingsLinkActive ? { 'aria-current': 'page' as const } : {})}
              >
                {t('nav.settings')}
              </Link>
            </MenuItem>
            {showAdminLink && (
              <MenuItem>
                <Link
                  to="/admin"
                  className={`block px-4 py-2 text-sm data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700 ${
                    adminLinkActive
                      ? 'text-blue-600 dark:text-blue-400 font-medium'
                      : 'text-gray-700 dark:text-gray-200'
                  }`}
                  {...(adminLinkActive ? { 'aria-current': 'page' as const } : {})}
                >
                  {t('nav.admin')}
                </Link>
              </MenuItem>
            )}
            <MenuItem>
              <button
                onClick={() => setShowLogoutConfirm(true)}
                className="block w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700 data-[focus]:text-red-600 dark:data-[focus]:text-red-400"
              >
                {t('nav.logout')}
              </button>
            </MenuItem>
          </div>
        </MenuItems>
      </Menu>
      <ConfirmDialog
        open={showLogoutConfirm}
        title={t('nav.logoutConfirmTitle')}
        message={t('nav.logoutConfirmMessage')}
        confirmLabel={t('nav.logout')}
        variant="danger"
        onConfirm={() => {
          setShowLogoutConfirm(false);
          onLogout();
        }}
        onCancel={() => setShowLogoutConfirm(false)}
      />
    </div>
  );
};

const NavigationHeader = ({ title = 'Jot', onLogout, children, username, isAdmin: showAdminLink, adminLinkActive, settingsLinkActive, onToggleSidebar }: NavigationHeaderProps) => {
  const { t } = useTranslation();
  const location = useLocation();
  const [showMobileAppBanner, setShowMobileAppBanner] = useState(() => !isMobileAppBannerDismissed());
  const currentUser = getUser();
  const baseUsername = username ?? currentUser?.username ?? '';
  const fullName = currentUser?.first_name || currentUser?.last_name
    ? `${currentUser.first_name} ${currentUser.last_name}`.trim()
    : null;
  const displayUsername = fullName ?? baseUsername;
  // Use updated_at as a cache-buster so the icon refreshes automatically
  // on any page after an upload or delete without needing a prop.
  const iconSrc = currentUser?.has_profile_icon
    ? `/api/v1/users/${currentUser.id}/profile-icon?v=${currentUser.updated_at}`
    : null;

  const profileMenuProps: ProfileMenuProps = {
    iconSrc,
    displayUsername,
    firstName: currentUser?.first_name,
    baseUsername,
    showAdminLink,
    adminLinkActive,
    settingsLinkActive,
    onLogout,
  };

  const openInAppHref = buildMobileDeepLink(location.pathname, window.location.origin);

  const handleDismissMobileAppBanner = () => {
    dismissMobileAppBanner();
    setShowMobileAppBanner(false);
  };

  return (
    <header className="bg-white dark:bg-slate-800 shadow-sm border-b border-gray-200 dark:border-slate-700">
      <div className="px-4 sm:px-6 lg:px-8">
        {/*
          flex-wrap + CSS order keeps a single ProfileMenu in the DOM:
          mobile  — row 1: [title (order-1)] … [profile (order-2)], row 2: [search (order-3, w-full)]
          desktop — one row: [title (order-1)] [search (sm:order-2, flex-1)] [profile (sm:order-3)]
        */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3 py-4">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              aria-label="Toggle sidebar"
              className="order-0 p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white"
            >
              <Bars3Icon className="h-7 w-7" />
            </button>
          )}
          <div className="order-1 flex items-center space-x-2 sm:space-x-4">
            {title === 'Jot' ? (
              <Link to="/" className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                {title}
              </Link>
            ) : (
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
            )}
          </div>

          {/* Single ProfileMenu — right of title on mobile, far right on desktop */}
          <div className="order-2 sm:order-3">
            <ProfileMenu {...profileMenuProps} />
          </div>

          {/* Search bar — wraps to row 2 on mobile, fills middle on desktop */}
          <div className="order-3 sm:order-2 w-full sm:w-auto sm:flex-1 flex justify-center">
            {children}
          </div>

          {/* Mobile app CTA on small screens */}
          {showMobileAppBanner && (
            <div className="order-4 w-full sm:hidden" data-testid="open-mobile-app-banner">
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-900/30">
                <p className="text-sm text-blue-800 dark:text-blue-200">{t('nav.openMobileAppDescription')}</p>
                <div className="mt-3 flex items-center gap-2">
                  <a
                    href={openInAppHref}
                    className="inline-flex flex-1 items-center justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
                    data-testid="open-mobile-app-link"
                  >
                    {t('nav.openMobileApp')}
                  </a>
                  <button
                    type="button"
                    onClick={handleDismissMobileAppBanner}
                    className="inline-flex items-center justify-center rounded-md border border-blue-200 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:focus:ring-offset-slate-800"
                    data-testid="dismiss-mobile-app-banner"
                  >
                    {t('nav.dismissMobileAppBanner')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default NavigationHeader;
