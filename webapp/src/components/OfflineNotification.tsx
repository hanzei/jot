import { useTranslation } from 'react-i18next';
import { CloudOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export function OfflineNotification() {
  const isOnline = useOnlineStatus();
  const { t } = useTranslation();

  if (isOnline) {
    return null;
  }

  return (
    <div role="alert" aria-atomic="true" className="fixed top-0 left-0 right-0 bg-orange-500 text-white px-4 py-2 text-center text-sm z-50 animate-slide-down motion-reduce:animate-none">
      <div className="flex items-center justify-center gap-2">
        <CloudOff className="w-4 h-4" />
        {t('offline.message')}
      </div>
    </div>
  );
}