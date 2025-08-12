import { ReactNode } from 'react';
import { UserCircleIcon } from '@heroicons/react/24/outline';
import { Link } from 'react-router-dom';
import { getUser } from '@/utils/auth';

interface NavigationTab {
  label: string;
  element: ReactNode;
  isActive?: boolean;
}

interface NavigationHeaderProps {
  title?: string;
  onLogout: () => void;
  tabs: NavigationTab[];
  children?: ReactNode; // For content like search bar between title/tabs and user menu
}

const NavigationHeader = ({ title = 'Jot', onLogout, tabs, children }: NavigationHeaderProps) => {
  const currentUser = getUser();

  const handleLogout = () => {
    onLogout();
  };

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
              <div className="hidden sm:flex space-x-4">
                {tabs.map((tab, index) => (
                  <div key={index}>
                    {tab.element}
                  </div>
                ))}
              </div>
            </div>

            {/* Mobile user menu */}
            <div className="flex items-center space-x-2 sm:hidden">
              <div className="flex items-center space-x-1 text-xs text-gray-600 dark:text-gray-300">
                <UserCircleIcon className="h-4 w-4" />
                <span className="max-w-16 truncate">{currentUser?.username}</span>
              </div>
              <button
                onClick={handleLogout}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400"
              >
                Logout
              </button>
            </div>
          </div>

          {/* Children content (like search bar) */}
          {children}

          {/* Desktop user menu */}
          <div className="hidden sm:flex items-center space-x-4">
            <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300">
              <UserCircleIcon className="h-5 w-5" />
              <span>{currentUser?.username}</span>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400"
            >
              Logout
            </button>
          </div>

          {/* Mobile tabs */}
          <div className="flex sm:hidden space-x-4 justify-center">
            {tabs.map((tab, index) => (
              <div key={index}>
                {tab.element}
              </div>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
};

export default NavigationHeader;