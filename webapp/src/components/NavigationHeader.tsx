import { type FocusEvent, type KeyboardEvent, type Ref, ReactNode, cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Bars3Icon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import LetterAvatar from '@/components/LetterAvatar';
import ConfirmDialog from '@/components/ConfirmDialog';
import { getUser } from '@/utils/auth';

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

interface HeaderSearchChildProps {
  value?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  inputTabIndex?: number;
  containerClassName?: string;
  onInputBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
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

  const searchElement = isValidElement<HeaderSearchChildProps>(children) ? children : null;
  const searchValue = typeof searchElement?.props.value === 'string' ? searchElement.props.value : '';
  const [searchExpanded, setSearchExpanded] = useState(() => searchValue.trim().length > 0);
  const [dismissedSearchQuery, setDismissedSearchQuery] = useState<string | null>(null);
  const hasSearch = Boolean(searchElement);
  const trimmedSearchValue = searchValue.trim();
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const [shouldFocusMobileSearch, setShouldFocusMobileSearch] = useState(false);

  useEffect(() => {
    if (!trimmedSearchValue) {
      setDismissedSearchQuery(null);
      return;
    }

    if (dismissedSearchQuery !== trimmedSearchValue) {
      setSearchExpanded(true);
    }
  }, [dismissedSearchQuery, trimmedSearchValue]);

  useEffect(() => {
    if (!shouldFocusMobileSearch || !searchExpanded) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      mobileSearchInputRef.current?.focus();
      setShouldFocusMobileSearch(false);
    });

    return () => cancelAnimationFrame(frame);
  }, [searchExpanded, shouldFocusMobileSearch]);

  const handleExpandSearch = () => {
    setDismissedSearchQuery(null);
    setSearchExpanded(true);
    setShouldFocusMobileSearch(true);
  };

  const collapseSearch = (rememberCurrentQuery: boolean) => {
    if (rememberCurrentQuery && trimmedSearchValue) {
      setDismissedSearchQuery(trimmedSearchValue);
    }
    setSearchExpanded(false);
  };

  const mobileSearch = searchElement
    ? cloneElement(searchElement, {
        autoFocus: false,
        inputRef: mobileSearchInputRef,
        inputTabIndex: searchExpanded ? 0 : -1,
        containerClassName: 'max-w-none',
        onInputBlur: (event: FocusEvent<HTMLInputElement>) => {
          searchElement.props.onInputBlur?.(event);
          if (!event.currentTarget.value.trim()) {
            collapseSearch(false);
          }
        },
        onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
          searchElement.props.onInputKeyDown?.(event);
          if (event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.blur();
            collapseSearch(true);
          }
        },
      })
    : children;

  return (
    <header className="bg-white dark:bg-slate-800 shadow-sm border-b border-gray-200 dark:border-slate-700">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="py-4 sm:hidden">
          <div className="relative min-h-10">
            <div
              aria-hidden={searchExpanded && hasSearch}
              inert={searchExpanded && hasSearch ? true : undefined}
              className={`flex items-center justify-between gap-3 transition-all duration-200 ${
                searchExpanded && hasSearch
                  ? 'opacity-0 -translate-y-1 pointer-events-none'
                  : 'opacity-100 translate-y-0'
              }`}
            >
              <div className="flex items-center gap-2">
                {onToggleSidebar && (
                  <button
                    onClick={onToggleSidebar}
                    aria-label="Toggle sidebar"
                    className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white"
                  >
                    <Bars3Icon className="h-7 w-7" />
                  </button>
                )}
                <div className="flex items-center space-x-2">
                  {title === 'Jot' ? (
                    <Link to="/" className="text-xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                      {title}
                    </Link>
                  ) : (
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white">{title}</h1>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {hasSearch && (
                  <button
                    type="button"
                    onClick={handleExpandSearch}
                    aria-controls="mobile-header-search"
                    aria-expanded={searchExpanded}
                    aria-label={t('dashboard.searchAriaLabel')}
                    className="rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-slate-700 dark:hover:text-white transition-colors"
                  >
                    <MagnifyingGlassIcon className="h-5 w-5" />
                  </button>
                )}
                <ProfileMenu {...profileMenuProps} />
              </div>
            </div>

            <div
              id="mobile-header-search"
              aria-hidden={!searchExpanded || !hasSearch}
              inert={!searchExpanded || !hasSearch ? true : undefined}
              className={`absolute inset-0 flex items-center gap-2 transition-all duration-200 ${
                searchExpanded && hasSearch
                  ? 'opacity-100 translate-y-0'
                  : 'opacity-0 translate-y-1 pointer-events-none'
              }`}
            >
              {onToggleSidebar && (
                <button
                  onClick={onToggleSidebar}
                  aria-label="Toggle sidebar"
                  className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white"
                >
                  <Bars3Icon className="h-7 w-7" />
                </button>
              )}
              <div className="flex-1 transition-all duration-200 ease-out">
                {mobileSearch}
              </div>
              <button
                onClick={() => collapseSearch(true)}
                aria-label={t('common.close')}
                className="px-2 py-1.5 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>

        <div className="hidden sm:flex items-center justify-between gap-x-3 gap-y-3 py-4">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              aria-label="Toggle sidebar"
              className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white"
            >
              <Bars3Icon className="h-7 w-7" />
            </button>
          )}
          <div className="flex items-center space-x-2 sm:space-x-4">
            {title === 'Jot' ? (
              <Link to="/" className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                {title}
              </Link>
            ) : (
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
            )}
          </div>

          <div className="min-w-0 flex-1 flex justify-center">
            {children}
          </div>
          <div>
            <ProfileMenu {...profileMenuProps} />
          </div>
        </div>
      </div>
    </header>
  );
};

export default NavigationHeader;
