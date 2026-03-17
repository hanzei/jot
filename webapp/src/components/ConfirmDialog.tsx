import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onClose={onCancel} className="relative z-[60]">
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="mx-auto w-full max-w-sm rounded-lg bg-white dark:bg-slate-800 shadow-xl border border-gray-200 dark:border-slate-700">
          <div className="p-6">
            <div className="flex items-start gap-3">
              {variant === 'danger' && (
                <div className="flex-shrink-0 rounded-full bg-red-100 dark:bg-red-900/30 p-2">
                  <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-400" />
                </div>
              )}
              <div>
                <DialogTitle className="text-base font-semibold text-gray-900 dark:text-white">
                  {title}
                </DialogTitle>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                  {message}
                </p>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200 dark:border-slate-700">
            <button
              onClick={onCancel}
              className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
            >
              {cancelLabel || t('import.cancelButton')}
            </button>
            <button
              onClick={onConfirm}
              className={`px-3 py-2 text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-slate-800 ${
                variant === 'danger'
                  ? 'text-white bg-red-600 hover:bg-red-700 focus:ring-red-500'
                  : 'text-white bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'
              }`}
            >
              {confirmLabel || t('note.delete')}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
