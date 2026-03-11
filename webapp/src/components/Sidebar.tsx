import { ReactNode, useState } from 'react';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';

interface SidebarTab {
  label: string;
  element: ReactNode;
}

interface SidebarProps {
  tabs: SidebarTab[];
  children?: ReactNode;
}

const Sidebar = ({ tabs, children }: SidebarProps) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <aside className="flex flex-col sm:w-48 h-full bg-white dark:bg-slate-800 border-b sm:border-b-0 sm:border-r border-gray-200 dark:border-slate-700 shrink-0">
      <button
        className="sm:hidden flex items-center px-4 py-3 text-gray-600 dark:text-gray-300"
        aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(o => !o)}
      >
        {mobileOpen ? (
          <XMarkIcon className="h-5 w-5" />
        ) : (
          <Bars3Icon className="h-5 w-5" />
        )}
      </button>
      <nav className={`flex-col space-y-1 p-4 ${mobileOpen ? 'flex' : 'hidden'} sm:flex`}>
        {tabs.map((tab) => (
          <div key={tab.label}>
            {tab.element}
          </div>
        ))}
      </nav>
      {children && (
        <div className={`${mobileOpen ? 'block' : 'hidden'} sm:block`}>
          {children}
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
