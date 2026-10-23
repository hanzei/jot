import { createContext, useContext } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
  // Called when the toast is dismissed without the action having run (auto-
  // dismiss timeout or the close button) — never after onClick. Lets a caller
  // drive a deferred action (e.g. a client-side delete behind an undo window)
  // off the toast's own single timer instead of racing a second one.
  onExpire?: () => void;
}

export interface ToastContextType {
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  // Shows an error toast for a failed request. When the server answered with
  // a 5xx, the toast also shows its request ID as a copyable reference the
  // user can quote in a bug report.
  showErrorToast: (message: string, error: unknown) => void;
}

export const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}
