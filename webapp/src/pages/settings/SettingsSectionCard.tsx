import type { ReactNode } from 'react';

export const CARD_CLASSES = 'bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700';
export const SECTION_TITLE_CLASSES = 'text-lg font-medium text-gray-900 dark:text-white mb-4';
const DANGER_CARD_CLASSES = 'bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-red-300 dark:border-red-900';
const DANGER_TITLE_CLASSES = 'text-lg font-medium text-red-700 dark:text-red-400 mb-4';
export const SETTINGS_BTN_CLASSES = 'inline-flex items-center px-4 py-2 border border-gray-300 dark:border-slate-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:ring-offset-gray-50 dark:focus:ring-offset-slate-900';

interface SettingsSectionCardProps {
  title: string;
  children: ReactNode;
  /** `danger` marks an irreversible action (a red border and title). */
  variant?: 'default' | 'danger';
}

/**
 * One titled panel on the settings page.
 *
 * Its own module so a section that decides for itself whether to render — see
 * `MobileAppPreference` — can wrap itself without importing `SettingsSections`,
 * which imports it back.
 */
const SettingsSectionCard = ({ title, children, variant = 'default' }: SettingsSectionCardProps) => (
  <section className={variant === 'danger' ? DANGER_CARD_CLASSES : CARD_CLASSES}>
    <h2 className={variant === 'danger' ? DANGER_TITLE_CLASSES : SECTION_TITLE_CLASSES}>{title}</h2>
    {children}
  </section>
);

export default SettingsSectionCard;
