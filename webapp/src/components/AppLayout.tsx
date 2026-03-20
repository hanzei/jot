import { type ReactElement, type ReactNode } from 'react';
import NavigationHeader from '@/components/NavigationHeader';
import type { SearchBarProps } from '@/components/SearchBar';
import Sidebar, { type SidebarTab } from '@/components/Sidebar';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';

interface AppLayoutProps {
  onLogout: () => void;
  title?: string;
  username?: string;
  isAdmin?: boolean;
  adminLinkActive?: boolean;
  settingsLinkActive?: boolean;
  sidebarTabs: SidebarTab[];
  sidebarBottomTabs?: SidebarTab[];
  sidebarChildren?: ReactNode;
  searchBar?: ReactElement<SearchBarProps>;
  children: ReactNode;
}

const AppLayout = ({
  onLogout,
  title,
  username,
  isAdmin,
  adminLinkActive,
  settingsLinkActive,
  sidebarTabs,
  sidebarBottomTabs,
  sidebarChildren,
  searchBar,
  children,
}: AppLayoutProps) => {
  const { collapsed, toggle: toggleSidebar, collapse: collapseSidebar } = useSidebarCollapsed();

  return (
    <div className="h-dvh bg-gray-50 dark:bg-slate-900 flex flex-col">
      <NavigationHeader
        title={title}
        onLogout={onLogout}
        username={username}
        isAdmin={isAdmin}
        adminLinkActive={adminLinkActive}
        settingsLinkActive={settingsLinkActive}
        onToggleSidebar={toggleSidebar}
        searchBar={searchBar}
      />

      <div className="relative flex flex-1 min-h-0">
        <Sidebar
          tabs={sidebarTabs}
          bottomTabs={sidebarBottomTabs}
          collapsed={collapsed}
          onCollapse={collapseSidebar}
        >
          {sidebarChildren}
        </Sidebar>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
