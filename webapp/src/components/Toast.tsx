import { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react';
import { XMarkIcon, CheckCircleIcon, ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/24/outline';

type ToastType = 'success' | 'error' | 'info';

interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType, action?: ToastMessage['action']) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = 'success', action?: ToastMessage['action']) => {
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
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 200);
    }, 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

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
          setTimeout(() => onDismiss(toast.id), 200);
        }}
        className="ml-1 p-0.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
      >
        <XMarkIcon className="h-4 w-4 text-gray-400" />
      </button>
    </div>
  );
}
