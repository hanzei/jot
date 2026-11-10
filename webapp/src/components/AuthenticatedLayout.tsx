import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useSSE } from '@/hooks/useSSE';
import type { SSEEvent } from '@/hooks/useSSE';
import { Outlet, useLocation, useOutletContext, useMatch, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Archive,
  Trash2,
  ClipboardCheck,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import ErrorBoundary from '@/components/ErrorBoundary';
import ErrorFallback from '@/components/ErrorFallback';
import SidebarLabels from '@/components/SidebarLabels';
import { useSidebarLabelsController } from '@/hooks/useSidebarLabelsController';
import { auth } from '@/utils/api';
import { removeUser, isAdmin } from '@/utils/auth';
import { DEFAULT_TRASH_RETENTION_DAYS, type Label, type LabelWithCount } from '@jot/shared';

interface LabelCallbacks {
  onRenameSuccess?: (label: Label, newName: string) => void | Promise<void>;
  onDeleteSuccess?: (label: Label) => void | Promise<void>;
}

interface SSECallbacks {
  onEvent?: (event: SSEEvent) => void;
  onConnected?: () => void;
}

export interface AuthenticatedLayoutContext {
  labels: LabelWithCount[];
  loadLabels: (opts?: { preserveOnError?: boolean }) => Promise<LabelWithCount[] | null>;
  handleCreateLabel: (name: string) => Promise<boolean>;
  handleRenameLabel: (label: Label, name: string) => Promise<boolean>;
  handleDeleteLabel: (label: Label) => Promise<boolean>;
  registerLabelCallbacks: (callbacks: LabelCallbacks) => void;
  registerSSECallbacks: (callbacks: SSECallbacks) => void;
  setSearchBar: (content: ReactNode) => void;
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook colocated with its layout by design; not worth a separate module
export const useAuthenticatedLayout = () => useOutletContext<AuthenticatedLayoutContext>();

interface AuthenticatedLayoutProps {
  onLogout: () => void;
  /** `/config`'s `trash_retention_days`, for the bin tab's tooltip. 0 means no automatic purge. */
  trashRetentionDays?: number;
}

const AuthenticatedLayout = ({ onLogout, trashRetentionDays = DEFAULT_TRASH_RETENTION_DAYS }: AuthenticatedLayoutProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Track which route we're on for sidebar active states
  const isAtRoot = useMatch('/');
  const isAtNoteId = useMatch('/notes/:noteId');
  const isAtNewNote = useMatch('/new');
  const isAtDashboard = !!(isAtRoot || isAtNoteId || isAtNewNote);
  const isAtAdmin = !!useMatch('/admin');
  const isAtSettings = !!useMatch('/settings');

  // Search bar slot: Dashboard injects its search bar via setSearchBar
  const [searchBar, setSearchBar] = useState<ReactNode>(null);

  // Label callbacks registered by Dashboard so it can react to label changes
  const labelCallbacksRef = useRef<LabelCallbacks>({});

  // SSE callbacks registered by Dashboard so it can react to real-time events.
  // Stored in a ref so registration doesn't restart the SSE connection.
  const sseCallbacksRef = useRef<SSECallbacks>({});

  const registerSSECallbacks = useCallback((callbacks: SSECallbacks) => {
    sseCallbacksRef.current = callbacks;
  }, []);

  const sseStatus = useSSE({
    onEvent: (event) => sseCallbacksRef.current.onEvent?.(event),
    onConnected: () => sseCallbacksRef.current.onConnected?.(),
  });

  const handleLabelRenameSuccess = useCallback(async (label: Label, newName: string) => {
    await labelCallbacksRef.current.onRenameSuccess?.(label, newName);
  }, []);

  const handleLabelDeleteSuccess = useCallback(async (label: Label) => {
    await labelCallbacksRef.current.onDeleteSuccess?.(label);
  }, []);

  const {
    labels,
    loadLabels,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
  } = useSidebarLabelsController({
    onRenameSuccess: handleLabelRenameSuccess,
    onDeleteSuccess: handleLabelDeleteSuccess,
  });

  useEffect(() => {
    void loadLabels();
  }, [loadLabels]);

  // Dashboard calls registerLabelCallbacks once on mount (via a stable useEffect)
  // to wire up page-specific reactions to label renames and deletes. The callbacks
  // are stored in labelCallbacksRef.current so they can be replaced without
  // restarting useSidebarLabelsController. Callers should register once per mount
  // and rely on closure-captured refs (e.g. selectedLabelIdRef) for fresh values
  // rather than re-registering on every render.
  const registerLabelCallbacks = useCallback((callbacks: LabelCallbacks) => {
    labelCallbacksRef.current = callbacks;
  }, []);

  // Sidebar tab active states computed from URL
  const view = searchParams.get('view');
  const selectedLabelId = searchParams.get('label');

  const tabs = useMemo(() => [
    {
      label: t('dashboard.tabNotes'),
      icon: <FileText className="h-4 w-4 shrink-0" />,
      href: '/',
      isActive: isAtDashboard && !view && !selectedLabelId,
    },
    {
      label: t('dashboard.tabMyTasks'),
      icon: <ClipboardCheck className="h-4 w-4 shrink-0" />,
      href: '/?view=my-tasks',
      isActive: isAtDashboard && view === 'my-tasks',
      title: t('dashboard.myTasksTooltip'),
    },
  ], [t, isAtDashboard, view, selectedLabelId]);

  const bottomTabs = useMemo(() => [
    {
      label: t('dashboard.tabArchive'),
      title: t('dashboard.archiveTooltip'),
      icon: <Archive className="h-4 w-4 shrink-0" />,
      href: '/?view=archive',
      isActive: isAtDashboard && view === 'archive',
    },
    {
      label: t('dashboard.tabBin'),
      title: trashRetentionDays === 0
        ? t('dashboard.binTooltipUntilEmptied')
        : t('dashboard.binTooltip', { count: trashRetentionDays }),
      icon: <Trash2 className="h-4 w-4 shrink-0" />,
      href: '/?view=bin',
      isActive: isAtDashboard && view === 'bin',
    },
  ], [t, isAtDashboard, view, trashRetentionDays]);

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
    await removeUser();
    onLogout();
  }, [onLogout]);

  const sidebarChildren = useMemo(() => (
    <SidebarLabels
      labels={labels}
      selectedLabelId={isAtDashboard ? selectedLabelId : null}
      onSelect={handleLabelSelect}
      onCreate={handleCreateLabel}
      onRename={handleRenameLabel}
      onDelete={handleDeleteLabel}
    />
  ), [labels, isAtDashboard, selectedLabelId, handleLabelSelect, handleCreateLabel, handleRenameLabel, handleDeleteLabel]);

  const context = useMemo<AuthenticatedLayoutContext>(() => ({
    labels,
    loadLabels,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
    registerLabelCallbacks,
    registerSSECallbacks,
    setSearchBar,
  }), [
    labels,
    loadLabels,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
    registerLabelCallbacks,
    registerSSECallbacks,
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
      sseStatus={sseStatus}
    >
      {/* Route-level, so a page that fails to render leaves the header and
          sidebar usable; navigating elsewhere clears it. */}
      <ErrorBoundary
        name="route"
        resetKey={location.pathname + location.search}
        fallback={(props) => <ErrorFallback {...props} variant="section" />}
      >
        <Outlet context={context} />
      </ErrorBoundary>
    </AppLayout>
  );
};

export default AuthenticatedLayout;
