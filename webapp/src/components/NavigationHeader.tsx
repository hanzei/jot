import { cloneElement, isValidElement, type FocusEvent, type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Bars3Icon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import LetterAvatar from '@/components/LetterAvatar';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { SearchBarProps } from '@/components/SearchBar';
import { getUser } from '@/utils/auth';

interface NavigationHeaderProps {
  title?: string;
  onLogout: () => void;
  searchBar?: ReactElement<SearchBarProps>;
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

const MOBILE_BREAKPOINT_QUERY = '(max-width: 639px)';
const DESKTOP_BREAKPOINT_QUERY = '(min-width: 640px)';

const matchesMediaQuery = (query: string) =>
  typeof window !== 'undefined' && window.matchMedia(query).matches;

const useMediaQuery = (query: string) => {
  const [matches, setMatches] = useState(() => matchesMediaQuery(query));

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQueryList = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQueryList.matches);

    updateMatches();
    mediaQueryList.addEventListener?.('change', updateMatches);
    mediaQueryList.addListener?.(updateMatches);

    return () => {
      mediaQueryList.removeEventListener?.('change', updateMatches);
      mediaQueryList.removeListener?.(updateMatches);
    };
  }, [query]);

  return matches;
};

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

const NavigationHeader = ({ title = 'Jot', onLogout, searchBar, username, isAdmin: showAdminLink, adminLinkActive, settingsLinkActive, onToggleSidebar }: NavigationHeaderProps) => {
  const currentUser = getUser();
  const { t } = useTranslation();
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const hasSearchBar = Boolean(searchBar);
  const searchValue = searchBar?.props.value.trim() ?? '';
  const baseUsername = username ?? currentUser?.username ?? '';
  const fullName = currentUser?.first_name || currentUser?.last_name
    ? `${currentUser.first_name} ${currentUser.last_name}`.trim()
    : null;
  const displayUsername = fullName ?? baseUsername;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileSearchContainerRef = useRef<HTMLDivElement | null>(null);
  const previousIsDesktopRef = useRef(isDesktop);
  const previousSearchValueRef = useRef(searchValue);
  const previousExpandedRef = useRef(false);
  // Use updated_at as a cache-buster so the icon refreshes automatically
  // on any page after an upload or delete without needing a prop.
  const iconSrc = currentUser?.has_profile_icon
    ? `/api/v1/users/${currentUser.id}/profile-icon?v=${currentUser.updated_at}`
    : null;
  const [searchExpanded, setSearchExpanded] = useState(
    () => !matchesMediaQuery(MOBILE_BREAKPOINT_QUERY) || Boolean(searchValue)
  );

  useEffect(() => {
    if (!hasSearchBar) {
      return;
    }

    if (isDesktop) {
      setSearchExpanded(true);
      previousIsDesktopRef.current = true;
      previousSearchValueRef.current = searchValue;
      return;
    }

    if (previousIsDesktopRef.current && !searchValue) {
      setSearchExpanded(false);
    } else if (searchValue && searchValue !== previousSearchValueRef.current) {
      setSearchExpanded(true);
    }

    previousIsDesktopRef.current = false;
    previousSearchValueRef.current = searchValue;
  }, [hasSearchBar, isDesktop, searchValue]);

  useEffect(() => {
    if (isDesktop) {
      previousExpandedRef.current = true;
      return;
    }

    if (searchExpanded && !previousExpandedRef.current) {
      const timeoutId = window.setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      previousExpandedRef.current = true;

      return () => window.clearTimeout(timeoutId);
    }

    previousExpandedRef.current = searchExpanded;
  }, [isDesktop, searchExpanded]);

  const collapseSearch = (focusTrigger = false) => {
    if (isDesktop) {
      return;
    }

    searchInputRef.current?.blur();
    setSearchExpanded(false);

    if (focusTrigger) {
      window.setTimeout(() => {
        searchTriggerRef.current?.focus();
      }, 0);
    }
  };

  const handleSearchBlur = (event: FocusEvent<HTMLInputElement>) => {
    const nextFocusedElement = event.relatedTarget;
    if (nextFocusedElement instanceof Node && mobileSearchContainerRef.current?.contains(nextFocusedElement)) {
      return;
    }

    if (!searchValue) {
      collapseSearch();
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      collapseSearch(true);
    }
  };

  const mobileSearchBar = hasSearchBar && isValidElement<SearchBarProps>(searchBar)
    ? cloneElement(searchBar, {
        className: 'w-full',
        inputRef: searchInputRef,
        inputTabIndex: searchExpanded ? 0 : -1,
        onBlur: (event) => {
          searchBar.props.onBlur?.(event);
          handleSearchBlur(event);
        },
        onKeyDown: (event) => {
          searchBar.props.onKeyDown?.(event);
          if (!event.defaultPrevented) {
            handleSearchKeyDown(event);
          }
        },
        showCloseButton: true,
        closeButtonTabIndex: searchExpanded ? 0 : -1,
        onClose: () => {
          searchBar.props.onClose?.();
          collapseSearch(true);
        },
      })
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

  return (
    <header className="bg-white dark:bg-slate-800 shadow-sm border-b border-gray-200 dark:border-slate-700">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3 py-4">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              aria-label={t('nav.toggleSidebar')}
              className="order-0 p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white"
            >
              <Bars3Icon className="h-7 w-7" />
            </button>
          )}
          <div className={`${hasSearchBar && !isDesktop && searchExpanded ? 'sr-only' : 'min-w-0 flex-1'} sm:flex sm:min-w-0 sm:flex-none sm:items-center sm:space-x-4`}>
            {title === 'Jot' ? (
              <Link
                to="/"
                tabIndex={hasSearchBar && !isDesktop && searchExpanded ? -1 : undefined}
                className="truncate text-xl sm:text-2xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400"
              >
                {title}
              </Link>
            ) : (
              <h1 className="truncate text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
            )}
          </div>

          {hasSearchBar && !isDesktop && (
            <div
              ref={mobileSearchContainerRef}
              className={`flex items-center gap-2 transition-[flex-basis,width] duration-200 ease-out ${
                searchExpanded ? 'min-w-0 flex-1 basis-0' : 'flex-none'
              }`}
            >
              <button
                ref={searchTriggerRef}
                type="button"
                aria-label={t('dashboard.openSearch')}
                aria-controls="mobile-navigation-search"
                aria-expanded={searchExpanded}
                onClick={() => setSearchExpanded(true)}
                tabIndex={searchExpanded ? -1 : 0}
                className={`flex h-9 items-center justify-center rounded-lg transition-all duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  searchExpanded
                    ? 'pointer-events-none w-0 opacity-0 scale-95'
                    : `w-9 opacity-100 scale-100 ${
                        searchValue
                          ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300'
                          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-slate-700 dark:hover:text-white'
                      }`
                }`}
              >
                <MagnifyingGlassIcon className="h-5 w-5" />
              </button>
              <div
                id="mobile-navigation-search"
                aria-hidden={!searchExpanded}
                className={`origin-right overflow-hidden transition-all duration-200 ease-out ${
                  searchExpanded
                    ? 'w-full opacity-100 scale-100'
                    : 'pointer-events-none w-0 opacity-0 scale-95'
                }`}
              >
                {mobileSearchBar}
              </div>
            </div>
          )}

          {hasSearchBar && isDesktop && (
            <div className="min-w-0 flex-1 justify-center sm:flex">
              {searchBar}
            </div>
          )}

          <div className="ml-auto flex-none sm:ml-0">
            <ProfileMenu {...profileMenuProps} />
          </div>
        </div>
      </div>
    </header>
  );
};

export default NavigationHeader;
