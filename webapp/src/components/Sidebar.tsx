import { ReactNode } from 'react';

interface SidebarTab {
  label: string;
  element: ReactNode;
}

interface SidebarProps {
  tabs: SidebarTab[];
}

const Sidebar = ({ tabs }: SidebarProps) => {
  return (
    <aside className="hidden sm:flex flex-col w-48 min-h-screen bg-white dark:bg-slate-800 border-r border-gray-200 dark:border-slate-700 shrink-0">
      <nav className="flex flex-col space-y-1 p-4">
        {tabs.map((tab) => (
          <div key={tab.label}>
            {tab.element}
          </div>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
