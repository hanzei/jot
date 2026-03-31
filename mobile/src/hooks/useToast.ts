import { createContext, useContext } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onPress: () => void | Promise<void>;
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
