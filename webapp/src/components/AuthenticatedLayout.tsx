import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Outlet, useOutletContext, useMatch, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  DocumentTextIcon,
  ArchiveBoxIcon,
  TrashIcon,
  ClipboardDocumentCheckIcon,
} from '@heroicons/react/24/outline';
import AppLayout from '@/components/AppLayout';
import SidebarLabels from '@/components/SidebarLabels';
import { useSidebarLabelsController } from '@/hooks/useSidebarLabelsController';
import { auth } from '@/utils/api';
import { removeUser, isAdmin } from '@/utils/auth';
import type { Label } from '@jot/shared';

interface LabelCallbacks {
  onRenameSuccess?: (label: Label, newName: string) => void | Promise<void>;
  onDeleteSuccess?: (label: Label) => void | Promise<void>;
}

export interface AuthenticatedLayoutContext {
  labels: Label[];
  labelCounts: Record<string, number> | null;
  loadLabels: (opts?: { preserveOnError?: boolean }) => Promise<Label[] | null>;
  loadLabelCounts: (opts?: { preserveOnError?: boolean }) => Promise<Record<string, number> | null>;
  handleCreateLabel: (name: string) => Promise<boolean>;
  handleRenameLabel: (label: Label, name: string) => Promise<boolean>;
  handleDeleteLabel: (label: Label) => Promise<boolean>;
  registerLabelCallbacks: (callbacks: LabelCallbacks) => void;
  setSearchBar: (content: ReactNode) => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuthenticatedLayout = () => useOutletContext<AuthenticatedLayoutContext>();

interface AuthenticatedLayoutProps {
  onLogout: () => void;
}

const AuthenticatedLayout = ({ onLogout }: AuthenticatedLayoutProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Track which route we're on for sidebar active states
  const isAtRoot = useMatch('/');
  const isAtNoteId = useMatch('/notes/:noteId');
  const isAtDashboard = !!(isAtRoot || isAtNoteId);
  const isAtAdmin = !!useMatch('/admin');
  const isAtSettings = !!useMatch('/settings');

  // Search bar slot: Dashboard injects its search bar via setSearchBar
  const [searchBar, setSearchBar] = useState<ReactNode>(null);

  // Label callbacks registered by Dashboard so it can react to label changes
  const labelCallbacksRef = useRef<LabelCallbacks>({});

  const handleLabelRenameSuccess = useCallback(async (label: Label, newName: string) => {
    await labelCallbacksRef.current.onRenameSuccess?.(label, newName);
  }, []);

  const handleLabelDeleteSuccess = useCallback(async (label: Label) => {
    await labelCallbacksRef.current.onDeleteSuccess?.(label);
  }, []);

  const {
    labels,
    labelCounts,
    loadLabels,
    loadLabelCounts,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
  } = useSidebarLabelsController({
    onRenameSuccess: handleLabelRenameSuccess,
    onDeleteSuccess: handleLabelDeleteSuccess,
  });

  useEffect(() => {
    void Promise.all([loadLabels(), loadLabelCounts()]);
  }, [loadLabels, loadLabelCounts]);

  const registerLabelCallbacks = useCallback((callbacks: LabelCallbacks) => {
    labelCallbacksRef.current = callbacks;
  }, []);

  // Sidebar tab active states computed from URL
  const view = searchParams.get('view');
  const selectedLabelId = searchParams.get('label');

  const tabs = useMemo(() => [
    {
      label: t('dashboard.tabNotes'),
      icon: <DocumentTextIcon className="h-4 w-4 shrink-0" />,
      href: '/',
      isActive: isAtDashboard && !view && !selectedLabelId,
    },
    {
      label: t('dashboard.tabMyTodo'),
      icon: <ClipboardDocumentCheckIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=my-todo',
      isActive: isAtDashboard && view === 'my-todo',
      title: t('dashboard.myTodoTooltip'),
    },
  ], [t, isAtDashboard, view, selectedLabelId]);

  const bottomTabs = useMemo(() => [
    {
      label: t('dashboard.tabArchive'),
      title: t('dashboard.archiveTooltip'),
      icon: <ArchiveBoxIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=archive',
      isActive: isAtDashboard && view === 'archive',
    },
    {
      label: t('dashboard.tabBin'),
      title: t('dashboard.binTooltip'),
      icon: <TrashIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=bin',
      isActive: isAtDashboard && view === 'bin',
    },
  ], [t, isAtDashboard, view]);

  const handleLabelSelect = useCallback((labelId: string) => {
    // When on Dashboard, toggle the label selection; from other pages, navigate to Dashboard
    if (isAtDashboard && selectedLabelId === labelId) {
      const params = new URLSearchParams(searchParams);
      params.delete('label');
      navigate(`/?${params.toString()}`);
    } else {
      navigate(`/?label=${encodeURIComponent(labelId)}`);
    }
  }, [isAtDashboard, selectedLabelId, searchParams, navigate]);

  const handleLogout = useCallback(async () => {
    try {
      await auth.logout();
    } catch {
      // Continue with logout even if the server call fails
    }
    removeUser();
    onLogout();
  }, [onLogout]);

  const sidebarChildren = useMemo(() => (
    <SidebarLabels
      labels={labels}
      labelCounts={labelCounts}
      selectedLabelId={isAtDashboard ? selectedLabelId : null}
      onSelect={handleLabelSelect}
      onCreate={handleCreateLabel}
      onRename={handleRenameLabel}
      onDelete={handleDeleteLabel}
    />
  ), [labels, labelCounts, isAtDashboard, selectedLabelId, handleLabelSelect, handleCreateLabel, handleRenameLabel, handleDeleteLabel]);

  const context = useMemo<AuthenticatedLayoutContext>(() => ({
    labels,
    labelCounts,
    loadLabels,
    loadLabelCounts,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
    registerLabelCallbacks,
    setSearchBar,
  }), [
    labels,
    labelCounts,
    loadLabels,
    loadLabelCounts,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
    registerLabelCallbacks,
  ]);

  return (
    <AppLayout
      title="Jot"
      onLogout={handleLogout}
      isAdmin={isAdmin()}
      adminLinkActive={isAtAdmin}
      settingsLinkActive={isAtSettings}
      sidebarTabs={tabs}
      sidebarBottomTabs={bottomTabs}
      sidebarChildren={sidebarChildren}
      searchBar={searchBar}
    >
      <Outlet context={context} />
    </AppLayout>
  );
};

export default AuthenticatedLayout;
