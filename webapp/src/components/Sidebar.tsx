import { ReactNode, useState } from 'react';
import { Link } from 'react-router';

interface SidebarTab {
  label: string;
  icon: ReactNode;
  isActive?: boolean;
  href?: string;
  onClick?: () => void;
}

interface SidebarProps {
  tabs: SidebarTab[];
  children?: ReactNode;
  collapsed: boolean;
  onCollapse?: () => void;
}

const tabClass = (isActive: boolean | undefined) =>
  `flex items-center gap-2 px-3 w-full h-8 rounded-md text-sm font-medium whitespace-nowrap ${
    isActive
      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700'
  }`;

const isMobile = () => window.matchMedia('(max-width: 639px)').matches;

const Sidebar = ({ tabs, children, collapsed, onCollapse }: SidebarProps) => {
  const [hovered, setHovered] = useState(false);
  const isExpanded = !collapsed || hovered;

  const handleTabClick = (onClick?: () => void) => {
    onClick?.();
    if (isMobile() && onCollapse) onCollapse();
  };

  return (
    <aside
      aria-label="Main navigation"
      className={`flex-col bg-white dark:bg-slate-800 border-r border-gray-200 dark:border-slate-700 overflow-hidden
        transition-[width] duration-200
        absolute inset-y-0 left-0 z-30 shadow-lg
        ${collapsed ? 'hidden' : 'flex'} sm:flex
        ${isExpanded ? 'w-48' : 'sm:w-12'}`}
      onMouseEnter={() => collapsed && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <nav className="flex flex-col space-y-1 p-2">
        {tabs.map((tab) =>
          tab.href ? (
            <Link
              key={tab.label}
              to={tab.href}
              aria-label={tab.label}
              aria-current={tab.isActive ? 'page' : undefined}
              className={tabClass(tab.isActive)}
              onClick={() => handleTabClick()}
            >
              {tab.icon}
              {isExpanded && tab.label}
            </Link>
          ) : (
            <button
              key={tab.label}
              onClick={() => handleTabClick(tab.onClick)}
              aria-label={tab.label}
              aria-current={tab.isActive ? 'page' : undefined}
              className={tabClass(tab.isActive)}
            >
              {tab.icon}
              {isExpanded && tab.label}
            </button>
          )
        )}
      </nav>
      {children && (
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
