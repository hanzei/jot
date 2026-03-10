import { useState, useRef } from 'react';
import { Dialog } from '@headlessui/react';
import { XMarkIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import { notes } from '@/utils/api';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ImportModal({ isOpen, onClose, onSuccess }: ImportModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError('');
    setResult(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      setSelectedFile(file);
      setError('');
      setResult(null);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleImport = async () => {
    if (!selectedFile) return;

    setIsLoading(true);
    setError('');
    setResult(null);

    try {
      const response = await notes.importKeep(selectedFile);
      setResult(response);
      onSuccess();
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: string } };
      setError(axiosError.response?.data || 'Import failed. Please check your file and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setSelectedFile(null);
    setError('');
    setResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/25" />

      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-md w-full rounded bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <Dialog.Title className="text-lg font-medium text-gray-900 dark:text-white">
                Import from Google Keep
              </Dialog.Title>
              <button
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Upload a Google Keep export file. Export your notes from{' '}
              <span className="font-medium">Google Takeout</span> and upload the{' '}
              <span className="font-mono text-xs bg-gray-100 dark:bg-slate-700 px-1 rounded">.zip</span> archive or an individual{' '}
              <span className="font-mono text-xs bg-gray-100 dark:bg-slate-700 px-1 rounded">.json</span> note file.
            </p>

            {error && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}

            {result && (
              <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-sm text-green-700 dark:text-green-400">
                Successfully imported {result.imported} note{result.imported !== 1 ? 's' : ''}
                {result.skipped > 0 && ` (${result.skipped} trashed note${result.skipped !== 1 ? 's' : ''} skipped)`}.
              </div>
            )}

            <div
              className="border-2 border-dashed border-gray-300 dark:border-slate-600 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <ArrowUpTrayIcon className="h-8 w-8 mx-auto text-gray-400 dark:text-gray-500 mb-2" />
              {selectedFile ? (
                <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">{selectedFile.name}</p>
              ) : (
                <>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Drop your file here, or <span className="text-blue-600 dark:text-blue-400">browse</span>
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">.zip or .json files</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.zip"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-600"
              >
                {result ? 'Close' : 'Cancel'}
              </button>
              {!result && (
                <button
                  onClick={handleImport}
                  disabled={!selectedFile || isLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md"
                >
                  {isLoading ? 'Importing...' : 'Import'}
                </button>
              )}
            </div>
          </Dialog.Panel>
        </div>
      </div>
    </Dialog>
  );
}
