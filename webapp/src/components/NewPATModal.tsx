import { useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useTranslation } from 'react-i18next';

interface NewPATModalProps {
  open: boolean;
  tokenName: string;
  token: string;
  onClose: () => void;
}

export default function NewPATModal({ open, tokenName, token, onClose }: NewPATModalProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers where clipboard API is unavailable.
      const ta = document.createElement('textarea');
      ta.value = token;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      if (document.execCommand('copy')) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
      document.body.removeChild(ta);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="relative z-[60]">
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="mx-auto w-full max-w-md rounded-lg bg-white dark:bg-slate-800 shadow-xl border border-gray-200 dark:border-slate-700">
          <div className="p-6">
            <DialogTitle className="text-base font-semibold text-gray-900 dark:text-white mb-1">
              {t('settings.patsNewTokenTitle')}
            </DialogTitle>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">
              <span className="font-medium">{tokenName}</span>
            </p>
            <p className="text-sm text-amber-600 dark:text-amber-400 mb-4">
              {t('settings.patsNewTokenWarning')}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={token}
                className="flex-1 min-w-0 border border-gray-300 dark:border-slate-600 rounded-md px-3 py-2 text-sm bg-gray-50 dark:bg-slate-700 text-gray-900 dark:text-white font-mono"
                onFocus={(e) => e.target.select()}
                aria-label={t('settings.patsNewTokenTitle')}
              />
              <button
                type="button"
                onClick={handleCopy}
                className="flex-shrink-0 px-3 py-2 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
              >
                {copied ? t('settings.patsNewTokenCopied') : t('settings.patsNewTokenCopy')}
              </button>
            </div>
          </div>
          <div className="flex justify-end px-6 py-4 border-t border-gray-200 dark:border-slate-700">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
            >
              {t('settings.patsNewTokenDone')}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
