import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Returns the standard sidebar navigation tabs as Link elements.
 * Used by non-Dashboard pages (Admin, Settings) so they stay in sync
 * with the Dashboard's Notes / Archive / Bin tabs.
 */
export function useNavigationLinkTabs() {
  const { t } = useTranslation();

  const linkClass =
    'px-3 py-1 rounded-md text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white';

  return [
    {
      label: t('dashboard.tabNotes'),
      element: (
        <Link to="/" className={linkClass}>
          {t('dashboard.tabNotes')}
        </Link>
      ),
    },
    {
      label: t('dashboard.tabArchive'),
      element: (
        <Link to="/?view=archive" className={linkClass}>
          {t('dashboard.tabArchive')}
        </Link>
      ),
    },
    {
      label: t('dashboard.tabBin'),
      element: (
        <Link to="/?view=bin" className={linkClass}>
          {t('dashboard.tabBin')}
        </Link>
      ),
    },
  ];
}
