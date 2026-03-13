import { useTranslation } from 'react-i18next';
import { DocumentTextIcon, ArchiveBoxIcon, TrashIcon } from '@heroicons/react/24/outline';

/**
 * Returns the standard sidebar navigation tabs as data objects.
 * Used by non-Dashboard pages (Admin, Settings) so they stay in sync
 * with the Dashboard's Notes / Archive / Bin tabs.
 */
export function useNavigationLinkTabs() {
  const { t } = useTranslation();

  return [
    {
      label: t('dashboard.tabNotes'),
      icon: <DocumentTextIcon className="h-4 w-4 shrink-0" />,
      href: '/',
    },
    {
      label: t('dashboard.tabArchive'),
      icon: <ArchiveBoxIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=archive',
    },
    {
      label: t('dashboard.tabBin'),
      icon: <TrashIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=bin',
    },
  ];
}
