import { useState, useEffect, useRef, useMemo } from 'react';
import { PlusIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { Label, Note } from '@jot/shared';
import { notes as notesApi, labels as labelsApi } from '@/utils/api';

interface LabelPickerProps {
  /** When editing an existing note, pass the note to use API-based label toggling. */
  note?: Note;
  /** For new notes: the currently selected labels (local state). */
  selectedLabels?: Label[];
  /** For new notes: callback when labels change locally. */
  onLocalChange?: (labels: Label[]) => void;
  onRefresh?: () => void;
  onNoteUpdate?: (note: Note) => void;
  onError?: (msg: string) => void;
  onClose: () => void;
}

export default function LabelPicker({ note, selectedLabels, onLocalChange, onRefresh, onNoteUpdate, onError, onClose }: LabelPickerProps) {
  const { t } = useTranslation();
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards the remote create path against duplicate submissions while a request
  // is in flight (rapid Enter presses / repeated create-row clicks).
  const isCreatingRef = useRef(false);

  const isLocalMode = !note;
  const currentLabelIds = new Set(
    isLocalMode
      ? (selectedLabels ?? []).map(l => l.id)
      : (note.labels ?? []).map(l => l.id)
  );
  const currentLabelNames = new Set(
    isLocalMode
      ? (selectedLabels ?? []).map(l => l.name)
      : (note.labels ?? []).map(l => l.name)
  );

  const trimmedQuery = query.trim();

  // Labels matching the current query (case-insensitive substring match).
  const filteredLabels = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return allLabels;
    return allLabels.filter(l => l.name.toLowerCase().includes(q));
  }, [allLabels, trimmedQuery]);

  // Offer to create only when there's input and no existing label matches it exactly.
  const showCreate =
    trimmedQuery.length > 0 &&
    !allLabels.some(l => l.name.toLowerCase() === trimmedQuery.toLowerCase());

  // Total number of selectable rows (filtered labels + optional create row).
  const optionCount = filteredLabels.length + (showCreate ? 1 : 0);
  const createIndex = showCreate ? filteredLabels.length : -1;
  const effectiveHighlight = optionCount === 0 ? -1 : Math.min(highlightIndex, optionCount - 1);

  useEffect(() => {
    labelsApi.getAll()
      .then(setAllLabels)
      .catch((err: Error) => onError?.(err.message));
  }, [onError]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Keep the search input focused so typing always works (keyboard-open UX).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset the highlight to the top whenever the query changes the option list.
  useEffect(() => {
    setHighlightIndex(0);
  }, [trimmedQuery]);

  const isSelected = (label: Label) =>
    currentLabelIds.has(label.id) || currentLabelNames.has(label.name);

  const toggleLabel = async (label: Label) => {
    if (isLocalMode) {
      const current = selectedLabels ?? [];
      if (isSelected(label)) {
        onLocalChange?.(current.filter(l => l.id !== label.id && l.name !== label.name));
      } else {
        onLocalChange?.([...current, label]);
      }
      return;
    }

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
    const trimmed = trimmedQuery;
    if (!trimmed) return;

    if (isLocalMode) {
      if (currentLabelNames.has(trimmed)) {
        setQuery('');
        return;
      }
      const existingLabel = allLabels.find(l => l.name === trimmed);
      if (existingLabel) {
        if (!isSelected(existingLabel)) {
          onLocalChange?.([...(selectedLabels ?? []), existingLabel]);
        }
      } else {
        const placeholder: Label = {
          id: `new_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          user_id: '',
          name: trimmed,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        onLocalChange?.([...(selectedLabels ?? []), placeholder]);
        setAllLabels(prev => [...prev, placeholder]);
      }
      setQuery('');
      return;
    }

    if (isCreatingRef.current) return;
    isCreatingRef.current = true;
    try {
      const updatedNote = await notesApi.addLabel(note.id, trimmed);
      labelsApi.getAll().then(setAllLabels).catch((err: Error) => onError?.(err.message));
      setQuery('');
      onNoteUpdate?.(updatedNote);
      onRefresh?.();
    } catch (err) {
      onError?.((err as Error).message);
    } finally {
      isCreatingRef.current = false;
    }
  };

  const activateHighlight = () => {
    if (effectiveHighlight < 0) return;
    if (effectiveHighlight === createIndex) {
      handleCreate();
    } else {
      const label = filteredLabels[effectiveHighlight];
      if (label) toggleLabel(label);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => Math.min(optionCount - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateHighlight();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-20 bottom-full mb-1 w-56 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg py-1"
    >
      <div className="px-2 pt-1 pb-1.5 border-b border-gray-200 dark:border-slate-600">
        <input
          ref={inputRef}
          type="text"
          autoCapitalize="none"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={t('labels.searchPlaceholder')}
          aria-label={t('labels.searchPlaceholder')}
          className="w-full text-sm px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div className="max-h-56 overflow-y-auto py-1" role="listbox">
        {filteredLabels.length === 0 && !showCreate && (
          <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('labels.noLabels')}</p>
        )}

        {filteredLabels.map((label, index) => (
          <button
            key={label.id}
            type="button"
            role="option"
            aria-selected={isSelected(label)}
            onClick={() => { setHighlightIndex(index); toggleLabel(label); }}
            onMouseEnter={() => setHighlightIndex(index)}
            className={`flex items-center w-full px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 ${index === effectiveHighlight ? 'bg-gray-100 dark:bg-slate-700' : ''}`}
          >
            <input
              type="checkbox"
              checked={isSelected(label)}
              readOnly
              aria-hidden="true"
              tabIndex={-1}
              className="h-3.5 w-3.5 text-blue-600 rounded mr-2 pointer-events-none"
            />
            <span className="truncate">{label.name}</span>
          </button>
        ))}

        {showCreate && (
          <button
            type="button"
            role="option"
            aria-selected={createIndex === effectiveHighlight}
            onClick={() => { setHighlightIndex(createIndex); handleCreate(); }}
            onMouseEnter={() => setHighlightIndex(createIndex)}
            className={`flex items-center w-full px-3 py-1.5 text-sm text-blue-600 dark:text-blue-400 ${createIndex === effectiveHighlight ? 'bg-gray-100 dark:bg-slate-700' : ''}`}
          >
            <PlusIcon className="h-3.5 w-3.5 mr-2 shrink-0" />
            <span className="truncate">{t('labels.createLabel', { name: trimmedQuery })}</span>
          </button>
        )}
      </div>
    </div>
  );
}
