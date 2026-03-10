import { useTranslation } from 'react-i18next';
import { useOnlineStatus } from '../utils/useOnlineStatus';

export function OfflineNotification() {
  const isOnline = useOnlineStatus();
  const { t } = useTranslation();

  if (isOnline) {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 bg-orange-500 text-white px-4 py-2 text-center text-sm z-50">
      <div className="flex items-center justify-center gap-2">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {t('offline.message')}
      </div>
    </div>
  );
}