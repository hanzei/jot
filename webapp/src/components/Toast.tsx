import { useState, useEffect, useCallback, useRef } from 'react';
import { XMarkIcon, CheckCircleIcon, ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { ToastContext, type ToastAction, type ToastType } from '@/hooks/useToast';

const TOAST_AUTO_DISMISS_MS = 4000;
const TOAST_ACTION_AUTO_DISMISS_MS = 7000;
const TOAST_EXIT_ANIMATION_MS = 200;

interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = 'success', action?: ToastAction) => {
    const id = nextId.current++;
    setToasts(prev => [...prev, { id, message, type, action }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const autoDismissMs = toast.action ? TOAST_ACTION_AUTO_DISMISS_MS : TOAST_AUTO_DISMISS_MS;

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), TOAST_EXIT_ANIMATION_MS);
    }, autoDismissMs);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss, autoDismissMs]);

  const Icon = toast.type === 'success' ? CheckCircleIcon
    : toast.type === 'error' ? ExclamationTriangleIcon
    : InformationCircleIcon;

  const iconColor = toast.type === 'success' ? 'text-green-500 dark:text-green-400'
    : toast.type === 'error' ? 'text-red-500 dark:text-red-400'
    : 'text-blue-500 dark:text-blue-400';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg border bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-sm text-gray-900 dark:text-white transition-all duration-200 ${
        visible && !exiting ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <Icon className={`h-5 w-5 flex-shrink-0 ${iconColor}`} />
      <span>{toast.message}</span>
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick();
            onDismiss(toast.id);
          }}
          className="ml-1 font-medium text-blue-600 dark:text-blue-400 hover:underline"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={() => {
          setExiting(true);
          setTimeout(() => onDismiss(toast.id), TOAST_EXIT_ANIMATION_MS);
        }}
        className="ml-1 p-0.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
        aria-label={t('common.close')}
      >
        <XMarkIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
      </button>
    </div>
  );
}
