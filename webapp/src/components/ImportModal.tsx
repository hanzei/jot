import { useState, useRef } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { notes, isAxiosError } from '@/utils/api';
import type { ImportResponse } from '@jot/shared';

type ImportType = 'jot_json' | 'google_keep';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ImportModal({ isOpen, onClose, onSuccess }: ImportModalProps) {
  const { t } = useTranslation();
  const [importType, setImportType] = useState<ImportType>('google_keep');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const acceptedFileTypes = importType === 'jot_json' ? '.json' : '.json,.zip';

  const isValidFile = (file: File): boolean => {
    const isJson = file.name.endsWith('.json') || file.type === 'application/json';
    if (importType === 'jot_json') return isJson;
    const isZip = file.name.endsWith('.zip') || file.type === 'application/zip';
    return isJson || isZip;
  };

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
      if (!isValidFile(file)) {
        setError(importType === 'jot_json' ? t('import.invalidFileTypeJson') : t('import.invalidFileType'));
        return;
      }
      setSelectedFile(file);
      setError('');
      setResult(null);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleFormatChange = (type: ImportType) => {
    setImportType(type);
    setSelectedFile(null);
    setError('');
    setResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleImport = async () => {
    if (!selectedFile) return;

    setIsLoading(true);
    setError('');
    setResult(null);

    try {
      const response = await notes.importNotes(selectedFile, importType);
      setResult(response);
      onSuccess();
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        setError(msg || t('import.importFailed'));
      } else {
        setError(t('import.importFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setImportType('google_keep');
    setSelectedFile(null);
    setError('');
    setResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  const description = importType === 'jot_json'
    ? t('import.descriptionJotJson')
    : t('import.description');

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/25" />

      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel className="mx-auto max-w-md w-full rounded bg-white dark:bg-slate-800 p-6 shadow-xl border border-gray-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <DialogTitle className="text-lg font-medium text-gray-900 dark:text-white">
                {t('import.title')}
              </DialogTitle>
              <button
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-4">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('import.formatLabel')}
              </p>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="import-format"
                    value="google_keep"
                    checked={importType === 'google_keep'}
                    onChange={() => handleFormatChange('google_keep')}
                    className="text-blue-600"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">{t('import.formatGoogleKeep')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="import-format"
                    value="jot_json"
                    checked={importType === 'jot_json'}
                    onChange={() => handleFormatChange('jot_json')}
                    className="text-blue-600"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">{t('import.formatJotJson')}</span>
                </label>
              </div>
            </div>

            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {description}
            </p>

            {error && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}

            {result && (
              <>
                <div className={`mb-4 p-3 rounded text-sm ${result.errors?.length ? 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-400' : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'}`}>
                  {result.imported === 1 ? t('import.importedNotes_one', { count: result.imported }) : t('import.importedNotes_other', { count: result.imported })}
                  {result.skipped > 0 && ` ${t('import.skipped', { count: result.skipped })}`}
                  {result.errors?.length ? `, ${t('import.failed', { count: result.errors.length })}` : ''}.
                </div>
                {result.errors && result.errors.length > 0 && (
                  <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-600 dark:text-red-400">
                    <ul className="list-disc list-inside space-y-1">
                      {result.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            <div
              data-testid="import-dropzone"
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
                    {t('import.dropFile')} <span className="text-blue-600 dark:text-blue-400">{t('import.browse')}</span>
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {importType === 'jot_json' ? t('import.fileTypesJson') : t('import.fileTypes')}
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptedFileTypes}
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-600"
              >
                {result ? t('import.close') : t('import.cancelButton')}
              </button>
              {!result && (
                <button
                  onClick={handleImport}
                  disabled={!selectedFile || isLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md"
                >
                  {isLoading ? t('import.importing') : t('import.importButton')}
                </button>
              )}
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
