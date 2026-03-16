import { useState, useEffect, useRef } from 'react';
import { PlusIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { Label, Note } from '@jot/shared';
import { notes as notesApi, labels as labelsApi } from '@/utils/api';

interface LabelPickerProps {
  note: Note;
  onRefresh?: () => void;
  onNoteUpdate?: (note: Note) => void;
  onError?: (msg: string) => void;
  onClose: () => void;
}

export default function LabelPicker({ note, onRefresh, onNoteUpdate, onError, onClose }: LabelPickerProps) {
  const { t } = useTranslation();
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentLabelIds = new Set((note.labels ?? []).map(l => l.id));

  useEffect(() => {
    labelsApi.getAll()
      .then(setAllLabels)
      .catch((err: Error) => onError?.(err.message));
  }, [onError]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Focus input when creating
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const toggleLabel = async (label: Label) => {
    try {
      let updatedNote: Note;
      if (currentLabelIds.has(label.id)) {
        updatedNote = await notesApi.removeLabel(note.id, label.id);
      } else {
        updatedNote = await notesApi.addLabel(note.id, label.name);
      }
      onNoteUpdate?.(updatedNote);
      onRefresh?.();
    } catch (err) {
      onError?.((err as Error).message);
    }
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      const updatedNote = await notesApi.addLabel(note.id, trimmed);
      labelsApi.getAll().then(setAllLabels).catch((err: Error) => onError?.(err.message));
      setNewName('');
      setCreating(false);
      onNoteUpdate?.(updatedNote);
      onRefresh?.();
    } catch (err) {
      onError?.((err as Error).message);
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-20 bottom-full mb-1 w-48 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg py-1"
    >
      {allLabels.length === 0 && !creating && (
        <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('labels.noLabels')}</p>
      )}

      {allLabels.map(label => (
        <button
          key={label.id}
          role="checkbox"
          aria-checked={currentLabelIds.has(label.id)}
          onClick={() => toggleLabel(label)}
          className="flex items-center w-full px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700"
        >
          <input
            type="checkbox"
            checked={currentLabelIds.has(label.id)}
            readOnly
            aria-hidden="true"
            tabIndex={-1}
            className="h-3.5 w-3.5 text-blue-600 rounded mr-2 pointer-events-none"
          />
          {label.name}
        </button>
      ))}

      <div className="border-t border-gray-200 dark:border-slate-600 mt-1 pt-1">
        {creating ? (
          <div className="px-3 py-1.5 flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
              placeholder={t('labels.newLabelPlaceholder')}
              className="flex-1 text-sm px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center w-full px-3 py-1.5 text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-slate-700"
          >
            <PlusIcon className="h-3.5 w-3.5 mr-2" />
            {t('labels.createNew')}
          </button>
        )}
      </div>
    </div>
  );
}
