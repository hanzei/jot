import { createContext, useContext } from 'react';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface ConfirmContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const noop = async () => false;

export const ConfirmContext = createContext<ConfirmContextType>({
  // Keep a safe default so isolated screen tests can run without a provider:
  // an unconfirmed destructive action must never proceed.
  confirm: noop,
});

export function useConfirm(): ConfirmContextType {
  return useContext(ConfirmContext);
}
