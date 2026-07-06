import { useState, useEffect, useCallback, useRef } from 'react';
import { X, CircleCheck, TriangleAlert, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToastContext, type ToastAction, type ToastType } from '@/hooks/useToast';
import {
  TOAST_ACTION_AUTO_DISMISS_MS,
  TOAST_AUTO_DISMISS_MS,
  TOAST_EXIT_ANIMATION_MS,
} from '@/utils/toastTiming';

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
  const [isActionInFlight, setIsActionInFlight] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const exitingRef = useRef(false);
  const actionInFlightRef = useRef(false);
  const autoDismissMs = toast.action ? TOAST_ACTION_AUTO_DISMISS_MS : TOAST_AUTO_DISMISS_MS;

  const clearAutoDismissTimer = useCallback(() => {
    if (autoDismissTimerRef.current) {
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }
  }, []);

  const beginDismiss = useCallback((fromAction = false) => {
    // Guard against a second dismiss (e.g. the auto-dismiss timer firing while
    // an exit is already animating) that would double-invoke onExpire.
    if (exitingRef.current) return;
    // Fire onExpire only when the toast is dismissed *without* its action having
    // run (auto-dismiss timeout or the close button) — never after onClick.
    if (!fromAction && !actionInFlightRef.current) {
      toast.action?.onExpire?.();
    }
    exitingRef.current = true;
    setExiting(true);
    clearAutoDismissTimer();
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
    }
    exitTimerRef.current = setTimeout(() => {
      onDismiss(toast.id);
      exitTimerRef.current = null;
    }, TOAST_EXIT_ANIMATION_MS);
  }, [clearAutoDismissTimer, onDismiss, toast.action, toast.id]);

  const handleAction = useCallback(async () => {
    // Ignore repeat taps so the action can't fire twice (e.g. a double-click on
    // "Undo" restoring a note twice).
    if (actionInFlightRef.current || exitingRef.current) return;
    actionInFlightRef.current = true;
    setIsActionInFlight(true);
    clearAutoDismissTimer();
    try {
      await toast.action?.onClick();
    } catch (error) {
      console.error('Toast action failed:', error);
    } finally {
      beginDismiss(true);
    }
  }, [beginDismiss, clearAutoDismissTimer, toast.action]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(() => {
      setVisible(true);
      rafRef.current = null;
    });
    autoDismissTimerRef.current = setTimeout(() => {
      beginDismiss();
    }, autoDismissMs);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      clearAutoDismissTimer();
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [autoDismissMs, beginDismiss, clearAutoDismissTimer]);

  const Icon = toast.type === 'success' ? CircleCheck
    : toast.type === 'error' ? TriangleAlert
    : Info;

  const iconColor = toast.type === 'success' ? 'text-green-500 dark:text-green-400'
    : toast.type === 'error' ? 'text-red-500 dark:text-red-400'
    : 'text-blue-500 dark:text-blue-400';

  return (
    <div
      data-testid="toast"
      role="status"
      aria-live="polite"
      className={`pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg border bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-sm text-gray-900 dark:text-white transition-all duration-200 max-w-[min(92vw,28rem)] ${
        visible && !exiting ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <Icon className={`h-5 w-5 flex-shrink-0 ${iconColor}`} />
      <span className="min-w-0 break-words">{toast.message}</span>
      {toast.action && (
        <button
          onClick={handleAction}
          disabled={isActionInFlight}
          className="ml-1 flex-shrink-0 font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-60 disabled:no-underline"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={() => beginDismiss()}
        className="ml-1 flex-shrink-0 p-0.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
        aria-label={t('common.close')}
      >
        <X className="h-4 w-4 text-gray-400" aria-hidden="true" />
      </button>
    </div>
  );
}
