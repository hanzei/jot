import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
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
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [focusedLabelIndex, setFocusedLabelIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const hasAutoFocused = useRef(false);

  // Effective focused index, clamped to valid range (derived in render, no setState needed).
  const effectiveFocusedIndex = allLabels.length === 0 ? 0 : Math.min(focusedLabelIndex, allLabels.length - 1);

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

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  // `position: fixed` lets the menu escape the modal's overflow-y-auto content
  // area, which would otherwise clip it — the labels row is the last child, so
  // neither an upward nor downward in-flow (absolute) menu fits when the note is
  // short. A fixed element is positioned against the viewport, so we compute its
  // coordinates from the trigger and flip vertically based on available space.
  // (Relies on no ancestor establishing a containing block via transform/filter;
  // the note modal's dialog panel has none.)
  const MENU_WIDTH = 192; // w-48
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
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    );
    setMenuStyle({
      position: 'fixed',
      left,
      width: MENU_WIDTH,
      maxHeight: `${Math.max(spaceAbove, spaceBelow) - GAP - VIEWPORT_MARGIN}px`,
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + GAP }
        : { top: rect.bottom + GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    // Measuring the trigger and setting position synchronously before paint is
    // the intended use of a layout effect (avoids a visible flash at 0,0).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    updatePosition();
    window.addEventListener('resize', updatePosition);
    // Capture scroll on any ancestor (the modal content scrolls) to keep the
    // menu glued to its trigger.
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition, allLabels.length, creating]);

  // Auto-focus the first label the first time labels load (keyboard-open UX).
  useEffect(() => {
    if (allLabels.length > 0 && !hasAutoFocused.current) {
      hasAutoFocused.current = true;
      labelButtonRefs.current[0]?.focus();
    }
  }, [allLabels.length]);

  const handleLabelKeyDown = useCallback((e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = Math.min(allLabels.length - 1, index + 1);
      setFocusedLabelIndex(nextIndex);
      labelButtonRefs.current[nextIndex]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIndex = Math.max(0, index - 1);
      setFocusedLabelIndex(nextIndex);
      labelButtonRefs.current[nextIndex]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [allLabels.length, onClose]);

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
    const trimmed = newName.trim();
    if (!trimmed) return;

    if (isLocalMode) {
      if (currentLabelNames.has(trimmed)) {
        setNewName('');
        setCreating(false);
        return;
      }
      const existingLabel = allLabels.find(l => l.name === trimmed);
      if (existingLabel) {
        onLocalChange?.([...(selectedLabels ?? []), existingLabel]);
      } else {
        const placeholder: Label = {
          id: `new_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          user_id: '',
          name: trimmed,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        onLocalChange?.([...(selectedLabels ?? []), placeholder]);
        // Prevent the auto-focus effect from firing when allLabels.length changes
        // due to this creation — the Enter key that triggered creation is still
        // being processed and auto-focusing a button would deliver its keyup to
        // the button, toggling the label back off.
        hasAutoFocused.current = true;
        setAllLabels(prev => [...prev, placeholder]);
      }
      setNewName('');
      setCreating(false);
      return;
    }

    try {
      const updatedNote = await notesApi.addLabel(note.id, trimmed);
      labelsApi.getAll().then(setAllLabels).catch((err: Error) => onError?.(err.message));
      setNewName('');
      setCreating(false);
      hasAutoFocused.current = true; // suppress auto-focus from the async label refresh
      onNoteUpdate?.(updatedNote);
      onRefresh?.();
    } catch (err) {
      onError?.((err as Error).message);
    }
  };

  return (
    <div
      ref={containerRef}
      style={menuStyle ?? { position: 'fixed', visibility: 'hidden' }}
      className="z-[1000] w-48 overflow-y-auto bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg py-1"
    >
      {allLabels.length === 0 && !creating && (
        <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('labels.noLabels')}</p>
      )}

      {allLabels.map((label, index) => (
        <button
          key={label.id}
          ref={el => { labelButtonRefs.current[index] = el; }}
          role="checkbox"
          aria-checked={isSelected(label)}
          tabIndex={index === effectiveFocusedIndex ? 0 : -1}
          onClick={() => { setFocusedLabelIndex(index); toggleLabel(label); }}
          onKeyDown={(e) => handleLabelKeyDown(e, index)}
          className="flex items-center w-full px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700"
        >
          <input
            type="checkbox"
            checked={isSelected(label)}
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
              autoCapitalize="none"
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
