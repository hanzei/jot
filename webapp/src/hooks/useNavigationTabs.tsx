import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { DocumentTextIcon, ArchiveBoxIcon, TrashIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline';

/**
 * Returns the standard sidebar navigation tabs as link-based data objects.
 * Used by non-Dashboard pages (Admin, Settings) so they stay in sync
 * with the Dashboard's tab structure.
 *
 * Returns `{ tabs, bottomTabs }` matching the Dashboard layout:
 *   tabs       → Notes, My Todo
 *   bottomTabs → Archive, Bin
 *
 * `isActive` is derived from the current URL: the view-specific tabs (My Todo,
 * Archive, Bin) are active only when the URL is exactly that dashboard view.
 * Notes is active whenever none of the other views is active — including when
 * on non-dashboard pages like Settings or Admin, where Notes is the home tab.
 */
export function useNavigationLinkTabs() {
  const { t } = useTranslation();
  const location = useLocation();

  const searchParams = new URLSearchParams(location.search);
  const view = location.pathname === '/' ? searchParams.get('view') : null;

  const isMyTodoActive = view === 'my-todo';
  const isArchiveActive = view === 'archive';
  const isBinActive = view === 'bin';
  const isNotesActive = !isMyTodoActive && !isArchiveActive && !isBinActive;

  const tabs = [
    {
      label: t('dashboard.tabNotes'),
      icon: <DocumentTextIcon className="h-4 w-4 shrink-0" />,
      href: '/',
      isActive: isNotesActive,
    },
    {
      label: t('dashboard.tabMyTodo'),
      icon: <ClipboardDocumentCheckIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=my-todo',
      isActive: isMyTodoActive,
    },
  ];

  const bottomTabs = [
    {
      label: t('dashboard.tabArchive'),
      title: t('dashboard.archiveTooltip'),
      icon: <ArchiveBoxIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=archive',
      isActive: isArchiveActive,
    },
    {
      label: t('dashboard.tabBin'),
      title: t('dashboard.binTooltip'),
      icon: <TrashIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=bin',
      isActive: isBinActive,
    },
  ];

  return { tabs, bottomTabs };
}
