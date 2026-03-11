import { useState, useEffect, useRef } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import { Label, Note } from '@/types';
import { notes as notesApi, labels as labelsApi } from '@/utils/api';

interface LabelPickerProps {
  note: Note;
  onRefresh?: () => void;
}

export default function LabelPicker({ note, onRefresh }: LabelPickerProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [currentLabels, setCurrentLabels] = useState<Label[]>(note.labels ?? []);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync currentLabels when note.labels changes externally
  useEffect(() => {
    setCurrentLabels(note.labels ?? []);
  }, [note.labels]);

  useEffect(() => {
    labelsApi.getAll().then(setAllLabels).catch(() => {});
  }, []);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const currentLabelIds = new Set(currentLabels.map(l => l.id));

  const suggestions = allLabels.filter(
    l => !currentLabelIds.has(l.id) && l.name.toLowerCase().includes(input.toLowerCase())
  );

  const exactMatch = allLabels.find(l => l.name.toLowerCase() === input.toLowerCase());
  const showCreate = input.trim() !== '' && !exactMatch;

  const addLabel = async (name: string) => {
    try {
      const updatedNote = await notesApi.addLabel(note.id, name);
      setCurrentLabels(updatedNote.labels ?? []);
      // Refresh allLabels to include any newly created one
      labelsApi.getAll().then(setAllLabels).catch(() => {});
      setInput('');
      setShowSuggestions(false);
      onRefresh?.();
    } catch {
      // silently ignore
    }
  };

  const removeLabel = async (labelId: string) => {
    try {
      const updatedNote = await notesApi.removeLabel(note.id, labelId);
      setCurrentLabels(updatedNote.labels ?? []);
      onRefresh?.();
    } catch {
      // silently ignore
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed) return;
      if (suggestions.length > 0) {
        addLabel(suggestions[0].name);
      } else if (showCreate) {
        addLabel(trimmed);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  return (
    <div ref={containerRef} className="space-y-2">
      {/* Applied labels */}
      {currentLabels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {currentLabels.map(label => (
            <span
              key={label.id}
              className="inline-flex items-center gap-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full px-2 py-0.5 text-xs"
            >
              {label.name}
              <button
                onClick={() => removeLabel(label.id)}
                aria-label={t('labels.removeLabel', { name: label.name })}
                className="hover:text-blue-900 dark:hover:text-blue-100"
              >
                <XMarkIcon className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={t('labels.searchPlaceholder')}
          className="w-full text-sm px-3 py-1.5 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        {showSuggestions && (suggestions.length > 0 || showCreate) && (
          <ul className="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg max-h-40 overflow-y-auto">
            {suggestions.map(label => (
              <li key={label.id}>
                <button
                  onMouseDown={e => { e.preventDefault(); addLabel(label.name); }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700"
                >
                  {label.name}
                </button>
              </li>
            ))}
            {showCreate && (
              <li>
                <button
                  onMouseDown={e => { e.preventDefault(); addLabel(input.trim()); }}
                  className="w-full text-left px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-slate-700"
                >
                  {t('labels.createLabel', { name: input.trim() })}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
