import { useTranslation } from 'react-i18next';
import { DocumentTextIcon, ArchiveBoxIcon, TrashIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline';

/**
 * Returns the standard sidebar navigation tabs as link-based data objects.
 * Used by non-Dashboard pages (Admin, Settings) so they stay in sync
 * with the Dashboard's tab structure.
 *
 * Returns `{ tabs, bottomTabs }` matching the Dashboard layout:
 *   tabs       → Notes, My Tasks
 *   bottomTabs → Archive, Bin
 */
export function useNavigationLinkTabs() {
  const { t } = useTranslation();

  const tabs = [
    {
      label: t('dashboard.tabNotes'),
      icon: <DocumentTextIcon className="h-4 w-4 shrink-0" />,
      href: '/',
    },
    {
      label: t('dashboard.tabMyTodo'),
      icon: <ClipboardDocumentCheckIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=my-todo',
    },
  ];

  const bottomTabs = [
    {
      label: t('dashboard.tabArchive'),
      title: t('dashboard.archiveTooltip'),
      icon: <ArchiveBoxIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=archive',
    },
    {
      label: t('dashboard.tabBin'),
      title: t('dashboard.binTooltip'),
      icon: <TrashIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=bin',
    },
  ];

  return { tabs, bottomTabs };
}
