import { useTranslation } from 'react-i18next';
import { FileText, Archive, Trash2, ClipboardCheck } from 'lucide-react';

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
      icon: <FileText className="h-4 w-4 shrink-0" />,
      href: '/',
    },
    {
      label: t('dashboard.tabMyTasks'),
      icon: <ClipboardCheck className="h-4 w-4 shrink-0" />,
      href: '/?view=my-tasks',
    },
  ];

  const bottomTabs = [
    {
      label: t('dashboard.tabArchive'),
      title: t('dashboard.archiveTooltip'),
      icon: <Archive className="h-4 w-4 shrink-0" />,
      href: '/?view=archive',
    },
    {
      label: t('dashboard.tabBin'),
      title: t('dashboard.binTooltip'),
      icon: <Trash2 className="h-4 w-4 shrink-0" />,
      href: '/?view=bin',
    },
  ];

  return { tabs, bottomTabs };
}
