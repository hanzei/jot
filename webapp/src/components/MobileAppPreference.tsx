import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsSectionCard from '@/pages/settings/SettingsSectionCard';
import {
  isHandoffCapableDevice,
  isMobileAppHandoffDismissed,
  setMobileAppHandoffDismissed,
} from '@/utils/mobileAppHandoff';

/**
 * The way back into the arrival handoff after "Continue in browser".
 *
 * Self-contained rather than threaded through `Settings` like the theme and
 * language rows: those are account settings the server stores, while this is a
 * single localStorage flag scoped to this browser profile. There is nothing to
 * lift.
 *
 * Hidden on a fine pointer, matching the handoff itself — a toggle for
 * behaviour that can never fire on this device is noise, not a preference.
 */
const MobileAppPreference = () => {
  const { t } = useTranslation();
  const [isCapable] = useState(isHandoffCapableDevice);
  const [enabled, setEnabled] = useState(() => !isMobileAppHandoffDismissed());

  if (!isCapable) {
    return null;
  }

  return (
    <SettingsSectionCard title={t('mobileApp.preferenceSection')}>
    <div data-testid="mobile-app-handoff-preference">
      <label htmlFor="mobile-app-handoff" className="flex items-center">
        <input
          id="mobile-app-handoff"
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setMobileAppHandoffDismissed(!e.target.checked);
          }}
          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 rounded"
        />
        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{t('mobileApp.preferenceLabel')}</span>
      </label>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('mobileApp.preferenceDescription')}</p>
    </div>
    </SettingsSectionCard>
  );
};

export default MobileAppPreference;
