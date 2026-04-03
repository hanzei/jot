import { type ReactNode, useEffect, useState } from 'react';
import NavigationHeader from '@/components/NavigationHeader';
import KeyboardShortcutsDialog from '@/components/KeyboardShortcutsDialog';
import Sidebar, { type SidebarTab } from '@/components/Sidebar';
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed';
import { isAnyModalDialogOpen, isEditableElementFocused, isOverlayControlFocused } from '@/utils/keyboardShortcuts';

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
  searchBar?: ReactNode;
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
  const [isKeyboardShortcutsOpen, setIsKeyboardShortcutsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const isQuestionMarkShortcut =
        (event.key === '?' || (event.code === 'Slash' && event.shiftKey)) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;
      if (!isQuestionMarkShortcut) {
        return;
      }

      if (isEditableElementFocused() || isOverlayControlFocused() || isAnyModalDialogOpen()) {
        return;
      }

      event.preventDefault();
      setIsKeyboardShortcutsOpen(true);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
        onOpenKeyboardShortcuts={() => setIsKeyboardShortcutsOpen(true)}
      >
        {searchBar}
      </NavigationHeader>

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
      <KeyboardShortcutsDialog
        isOpen={isKeyboardShortcutsOpen}
        onClose={() => setIsKeyboardShortcutsOpen(false)}
      />
    </div>
  );
};

export default AppLayout;
