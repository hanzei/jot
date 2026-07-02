import { createContext, useContext } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onPress: () => void | Promise<void>;
  // Called when the toast is dismissed without the action having run (auto-
  // dismiss timeout or the close button) — never after onPress. Lets a caller
  // drive a deferred action (e.g. the note-image delete behind an undo
  // window) off the toast's own single timer instead of racing a second one.
  onExpire?: () => void;
}

export interface ToastContextType {
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

const noop = () => {};

export const ToastContext = createContext<ToastContextType>({
  // Keep a no-op default so isolated screen tests can run without a provider.
  showToast: noop,
});

export function useToast(): ToastContextType {
  return useContext(ToastContext);
}
