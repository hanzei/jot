import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DocumentTextIcon, ArchiveBoxIcon, TrashIcon, ClipboardDocumentCheckIcon, TagIcon } from '@heroicons/react/24/outline';
import { labels as labelsApi } from '@/utils/api';
import type { Label } from '@jot/shared';

/**
 * Returns the standard sidebar navigation tabs as link-based data objects.
 * Used by non-Dashboard pages (Admin, Settings) so they stay in sync
 * with the Dashboard's tab structure.
 *
 * Returns `{ tabs, bottomTabs, sidebarChildren }` matching the Dashboard layout:
 *   tabs            → Notes, My Todo
 *   bottomTabs      → Archive, Bin
 *   sidebarChildren → Label links (navigates to dashboard filtered by label)
 */
export function useNavigationLinkTabs() {
  const { t } = useTranslation();
  const [labelsList, setLabelsList] = useState<Label[]>([]);

  useEffect(() => {
    let cancelled = false;
    labelsApi.getAll()
      .then((data) => { if (!cancelled) setLabelsList(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
      icon: <ArchiveBoxIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=archive',
    },
    {
      label: t('dashboard.tabBin'),
      icon: <TrashIcon className="h-4 w-4 shrink-0" />,
      href: '/?view=bin',
    },
  ];

  const sidebarChildren: ReactNode = labelsList.length > 0 ? (
    <div className="px-2 pb-2">
      <ul className="space-y-0.5">
        {labelsList.map((label) => (
          <li key={label.id}>
            <Link
              to={`/?label=${label.id}`}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-md text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700"
            >
              <TagIcon className="h-4 w-4 shrink-0" />
              <span className="truncate min-w-0">{label.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  ) : undefined;

  return { tabs, bottomTabs, sidebarChildren };
}
