import type { ReactNode } from 'react';

export const CARD_CLASSES = 'bg-white dark:bg-slate-800 shadow rounded-lg p-6 border border-gray-200 dark:border-slate-700';
export const SECTION_TITLE_CLASSES = 'text-lg font-medium text-gray-900 dark:text-white mb-4';

interface SettingsSectionCardProps {
  title: string;
  children: ReactNode;
}

/**
 * One titled panel on the settings page.
 *
 * Its own module so a section that decides for itself whether to render — see
 * `MobileAppPreference` — can wrap itself without importing `SettingsSections`,
 * which imports it back.
 */
const SettingsSectionCard = ({ title, children }: SettingsSectionCardProps) => (
  <section className={CARD_CLASSES}>
    <h2 className={SECTION_TITLE_CLASSES}>{title}</h2>
    {children}
  </section>
);

export default SettingsSectionCard;
