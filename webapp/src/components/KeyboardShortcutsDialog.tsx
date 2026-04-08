import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function KeyboardShortcutsDialog({ isOpen, onClose }: KeyboardShortcutsDialogProps) {
  const { t } = useTranslation();

  if (!isOpen) {
    return null;
  }

  const shortcuts = [
    {
      id: 'focus-search',
      key: t('keyboardShortcuts.focusSearchKey'),
      description: t('keyboardShortcuts.focusSearchDescription'),
    },
    {
      id: 'new-note',
      key: t('keyboardShortcuts.newNoteKey'),
      description: t('keyboardShortcuts.newNoteDescription'),
    },
    {
      id: 'notes-view',
      key: t('keyboardShortcuts.notesKey'),
      description: t('keyboardShortcuts.notesDescription'),
    },
    {
      id: 'my-tasks-view',
      key: t('keyboardShortcuts.myTasksKey'),
      description: t('keyboardShortcuts.myTasksDescription'),
    },
    {
      id: 'archive-view',
      key: t('keyboardShortcuts.archiveKey'),
      description: t('keyboardShortcuts.archiveDescription'),
    },
    {
      id: 'bin-view',
      key: t('keyboardShortcuts.binKey'),
      description: t('keyboardShortcuts.binDescription'),
    },
    {
      id: 'open-help',
      key: t('keyboardShortcuts.helpKey'),
      description: t('keyboardShortcuts.helpDescription'),
    },
    {
      id: 'open-note',
      key: t('keyboardShortcuts.openNoteKey'),
      description: t('keyboardShortcuts.openNoteDescription'),
    },
    {
      id: 'escape',
      key: t('keyboardShortcuts.escapeKey'),
      description: t('keyboardShortcuts.escapeDescription'),
    },
  ];

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          data-testid="keyboard-shortcuts-dialog"
          className="mx-auto w-full max-w-lg rounded-lg bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700"
        >
          <div className="flex items-center justify-between mb-4">
            <DialogTitle className="text-lg font-medium text-gray-900 dark:text-white">
              {t('keyboardShortcuts.title')}
            </DialogTitle>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          <div className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-3 text-sm">
            <div className="font-semibold text-gray-600 dark:text-gray-300">
              {t('keyboardShortcuts.shortcutColumn')}
            </div>
            <div className="font-semibold text-gray-600 dark:text-gray-300">
              {t('keyboardShortcuts.descriptionColumn')}
            </div>
            {shortcuts.map((shortcut) => (
              <div key={shortcut.id} className="contents">
                <div data-testid={`shortcut-key-${shortcut.id}`}>
                  <kbd className="inline-flex rounded border border-gray-300 dark:border-slate-600 bg-gray-100 dark:bg-slate-700 px-2 py-1 font-mono text-xs text-gray-800 dark:text-gray-100">
                    {shortcut.key}
                  </kbd>
                </div>
                <div data-testid={`shortcut-description-${shortcut.id}`} className="text-gray-700 dark:text-gray-200">
                  {shortcut.description}
                </div>
              </div>
            ))}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
