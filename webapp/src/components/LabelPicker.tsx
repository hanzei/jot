import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
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
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
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
      const target = e.target as Node;
      const wrapper = containerRef.current?.parentElement;
      if (containerRef.current?.contains(target) || wrapper?.contains(target)) return;
      onClose();
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

  // `position: fixed` lets the menu escape the modal's overflow-y-auto content
  // area, which would otherwise clip it — the labels row is the last child, so
  // neither an upward nor downward in-flow (absolute) menu fits when the note is
  // short. A fixed element is positioned against the viewport, so we compute its
  // coordinates from the trigger and flip vertically based on available space.
  // (Relies on no ancestor establishing a containing block via transform/filter;
  // the note modal's dialog panel has none.)
  const MENU_WIDTH = 224; // w-56
  const GAP = 4; // matches the old mb-1 / mt-1
  const VIEWPORT_MARGIN = 8;
  const updatePosition = useCallback(() => {
    const menu = containerRef.current;
    const wrapper = menu?.parentElement;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const menuHeight = menu?.offsetHeight ?? 0;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceAbove >= menuHeight + GAP || spaceAbove >= spaceBelow;
    // Shrink the menu on viewports narrower than its preferred width so it never
    // overflows horizontally, then clamp its left edge inside the viewport.
    const available = window.innerWidth - 2 * VIEWPORT_MARGIN;
    const width = available > 0 ? Math.min(MENU_WIDTH, available) : MENU_WIDTH;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    setMenuStyle({
      position: 'fixed',
      left,
      width,
      maxHeight: `${Math.max(spaceAbove, spaceBelow) - GAP - VIEWPORT_MARGIN}px`,
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + GAP }
        : { top: rect.bottom + GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    // Measuring the trigger and setting position synchronously before paint is
    // the intended use of a layout effect (avoids a visible flash at 0,0).
    updatePosition();
    // Coalesce high-frequency scroll/resize events into one update per frame so
    // scrolling the modal content while the picker is open doesn't thrash layout.
    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updatePosition();
      });
    };
    window.addEventListener('resize', scheduleUpdate);
    // Capture scroll on any ancestor (the modal content scrolls) to keep the
    // menu glued to its trigger; passive since we never preventDefault.
    window.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, { capture: true });
    };
    // Re-measure when the rendered height changes (filtered list grows/shrinks
    // or the create row toggles), which affects upward/downward placement.
  }, [updatePosition, filteredLabels.length, showCreate]);

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
      setHighlightIndex(i => Math.max(0, Math.min(optionCount - 1, i + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateHighlight();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.nativeEvent.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={containerRef}
      style={menuStyle ?? { position: 'fixed', visibility: 'hidden' }}
      className="z-[1000] flex flex-col overflow-hidden bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg"
    >
      <div className="flex-none px-2 pt-1 pb-1.5 border-b border-gray-200 dark:border-slate-600">
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

      <div className="flex-1 min-h-0 overflow-y-auto py-1" role="listbox">
        {filteredLabels.length === 0 && !showCreate && (
          <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('labels.noLabels')}</p>
        )}

        {filteredLabels.map((label, index) => (
          <button
            key={label.id}
            type="button"
            role="option"
            aria-selected={isSelected(label)}
            onMouseDown={(e) => e.preventDefault()}
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
            onMouseDown={(e) => e.preventDefault()}
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
