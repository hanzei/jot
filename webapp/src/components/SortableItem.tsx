import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, UserPlus, GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, type User, type Collaborator } from '@jot/shared';
import LetterAvatar from '@/components/LetterAvatar';
import AssigneePicker from '@/components/AssigneePicker';
import { indentOf, type ListItem } from '@/utils/noteItems';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Per-row controls (delete, assign) are hidden until the row is hovered
// (desktop) or a field within it is focused (works on touch). While hidden the
// control is also non-interactive, so an invisible button can't be tapped by
// accident — important on touch devices, where there's no hover to reveal it.
export const ROW_REVEAL_CLASSES =
  'opacity-0 pointer-events-none group-hover/item:opacity-100 group-hover/item:pointer-events-auto group-focus-within/item:opacity-100 group-focus-within/item:pointer-events-auto';

export interface SortableItemProps {
  id: string;
  index: number;
  item: ListItem;
  onUpdateListItem: (index: number, field: 'text' | 'completed', value: string | boolean) => Promise<void>;
  onRemoveListItem: (itemId: string) => void;
  isCompleted?: boolean;
  // A note in the bin renders its items view-only: no drag handle, no
  // checkbox/text/assignee edits, no per-row delete or suggestion dropdown.
  readOnly?: boolean;
  onKeyDown?: (index: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (index: number, e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  inputRef?: React.RefCallback<HTMLTextAreaElement>;
  onIndentChange?: (itemId: string, delta: 1 | -1) => void;
  isShared?: boolean;
  collaborators?: Collaborator[];
  usersById?: Map<string, User>;
  onAssignItem?: (itemId: string, userId: string) => void;
  completedItemTexts?: string[];
  onAcceptSuggestion?: (currentItemId: string, suggestionText: string) => void;
}

// A single draggable row in a list note: its checkbox, auto-resizing text
// field, the completed-item suggestion dropdown, the assignee picker, and the
// per-row delete control. Owns only its own transient UI state (which popovers
// are open, which suggestion is highlighted); every mutation is delegated back
// to NoteModal, which holds the item model.
export default function SortableItem({ id, index, item, onUpdateListItem, onRemoveListItem, isCompleted = false, readOnly = false, onKeyDown, onPaste, inputRef, onIndentChange, isShared, collaborators, usersById, onAssignItem, completedItemTexts = [], onAcceptSuggestion }: SortableItemProps) {
  const { t } = useTranslation();
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const listItemTextRef = useRef<HTMLTextAreaElement | null>(null);
  const closeAssigneePicker = useCallback(() => setShowAssigneePicker(false), []);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: isCompleted || readOnly
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    marginLeft: indentOf(item) * VALIDATION.INDENT_PX_PER_LEVEL,
  };

  const assignedUser = item.assignedTo ? usersById?.get(item.assignedTo) : undefined;
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignItem;
  const placeholder = item.text ? '' : t('note.itemPlaceholder');
  const autoResizeListItemText = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  const setListItemTextRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    listItemTextRef.current = textarea;
    autoResizeListItemText(textarea);
    inputRef?.(textarea);
  }, [autoResizeListItemText, inputRef]);

  useEffect(() => {
    autoResizeListItemText(listItemTextRef.current);
  }, [item.text, autoResizeListItemText]);

  const suggestions = useMemo(() => {
    const trimmed = item.text.trim();
    if (!trimmed) return [];
    const q = trimmed.toLowerCase();
    const results: string[] = [];
    for (const text of completedItemTexts) {
      const lower = text.toLowerCase();
      if (lower.includes(q) && lower !== q) {
        results.push(text);
        if (results.length === 5) break;
      }
    }
    return results;
  }, [item.text, completedItemTexts]);

  const selectSuggestion = (text: string) => {
    if (onAcceptSuggestion) {
      onAcceptSuggestion(item.id, text);
    } else {
      onUpdateListItem(index, 'text', text);
    }
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="list-item-row"
      className={`group/item flex items-start gap-2 ${isDragging ? 'opacity-50' : ''} ${
        isCompleted ? 'opacity-60' : ''
      }`}
    >
      {!isCompleted && !readOnly && (
        // dnd-kit's `attributes` (role, tabIndex, drag instructions) belong on
        // the same element as its `listeners`: the KeyboardSensor activates on
        // keydown, so splitting them leaves a focusable element that does
        // nothing and a grip that keyboard users cannot reach at all. Both go
        // on a real <button>, which also keeps the grip out of the row's own
        // semantics — a row carrying role="button" would be an interactive
        // control wrapping the checkbox, textarea and per-row buttons.
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={t('note.reorderItem')}
          title={t('note.reorderItem')}
          {...attributes}
          {...listeners}
          // gray-500, not gray-400: the note's colour is applied to the whole
          // modal panel, and the grip is a graphical control, so it needs 3:1
          // against the worst swatch (WCAG 1.4.11). gray-400 manages 1.8 there.
          // axe does not measure SVG contrast, so nothing catches this for us.
          className="cursor-grab active:cursor-grabbing p-1 text-gray-500 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-100"
        >
          <GripVertical className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
      {(isCompleted || readOnly) && <div className="w-6 h-4"></div>}

      <input
        type="checkbox"
        checked={item.completed}
        disabled={readOnly}
        onChange={(e) => onUpdateListItem(index, 'completed', e.target.checked)}
        aria-label={t('note.itemCompleted')}
        className={`h-4 w-4 text-blue-600 rounded mt-0.5 flex-shrink-0 ${readOnly ? 'cursor-default' : ''}`}
      />
      <div className="flex flex-1 items-start min-w-0">
        <div className="relative min-w-0 flex-1">
          <textarea
            data-testid="list-item-input"
            placeholder={placeholder}
            rows={1}
            autoCapitalize="sentences"
            readOnly={readOnly}
            aria-readonly={readOnly}
            className={`w-full pt-0 pb-1 pl-1 pr-0 bg-transparent border-none outline-none min-w-0 resize-none overflow-hidden whitespace-pre-wrap break-words placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white ${
              isCompleted ? 'line-through text-gray-500 dark:text-gray-400' : ''
            }`}
            value={item.text}
            onInput={(e) => autoResizeListItemText(e.currentTarget)}
            onChange={readOnly ? undefined : (e) => {
              onUpdateListItem(index, 'text', e.target.value);
              if (e.target.value.trim()) setShowSuggestions(true);
              setSelectedSuggestionIndex(-1);
            }}
            onFocus={readOnly ? undefined : () => {
              if (suggestions.length > 0) setShowSuggestions(true);
            }}
            onBlur={(e) => {
              const related = e.relatedTarget as Node | null;
              if (suggestionsRef.current?.contains(related)) return;
              // Delay to allow touch tap on suggestion to fire click first
              setTimeout(() => {
                setShowSuggestions(false);
                setSelectedSuggestionIndex(-1);
              }, 150);
            }}
            // Stays a native textbox. `aria-autocomplete`, `aria-controls` and
            // `aria-activedescendant` are all allowed on one, and together they
            // are the whole autocomplete contract: a list may appear, here it
            // is, and this is the entry currently highlighted.
            //
            // `aria-expanded` is the one attribute a textbox may not carry, and
            // role="combobox" is not a way around it — ARIA in HTML permits no
            // role override on <textarea>, and combobox additionally *requires*
            // aria-controls, which does not exist while the list is collapsed.
            aria-label={t('note.itemLabel')}
            aria-autocomplete="list"
            aria-controls={showSuggestions && suggestions.length > 0 ? `suggestions-${id}` : undefined}
            aria-activedescendant={selectedSuggestionIndex >= 0 ? `suggestion-${id}-${selectedSuggestionIndex}` : undefined}
            onKeyDown={readOnly ? undefined : (e) => {
              const suggestionsVisible = showSuggestions && suggestions.length > 0;
              if (suggestionsVisible && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedSuggestionIndex(prev => Math.min(prev + 1, suggestions.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedSuggestionIndex(prev => Math.max(prev - 1, -1));
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  // Only accept a suggestion the user explicitly highlighted
                  // (arrow keys or hover). With none highlighted, Enter keeps
                  // its normal add/split behavior below — the dropdown being
                  // merely visible must not hijack creating a new item.
                  //
                  // Reading the entry rather than testing the index also covers
                  // a highlight left pointing past the end: `suggestions`
                  // recomputes from `completedItemTexts`, which a collaborator's
                  // SSE update can shrink without the keystroke that would reset
                  // the index.
                  const highlighted = suggestions[selectedSuggestionIndex];
                  if (highlighted !== undefined) {
                    e.preventDefault();
                    selectSuggestion(highlighted);
                    return;
                  }
                  setShowSuggestions(false);
                  setSelectedSuggestionIndex(-1);
                }
                if (e.key === 'Escape' || e.key === 'Tab') {
                  e.preventDefault();
                  setShowSuggestions(false);
                  setSelectedSuggestionIndex(-1);
                  return;
                }
              }
              if (e.key === 'Tab' && onIndentChange && !isCompleted) {
                e.preventDefault();
                onIndentChange(item.id, e.shiftKey ? -1 : 1);
                return;
              }
              if (onKeyDown) onKeyDown(index, e);
            }}
            onPaste={readOnly ? undefined : (e) => onPaste?.(index, e)}
            ref={setListItemTextRef}
          />
          {showSuggestions && suggestions.length > 0 && !isCompleted && !readOnly && (
            <div
              ref={suggestionsRef}
              id={`suggestions-${id}`}
              role="listbox"
              aria-label={t('note.completedSuggestions')}
              className="absolute z-20 top-full left-0 mt-0.5 min-w-40 max-w-64 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg max-h-36 overflow-y-auto scrollbar-subtle"
            >
              {suggestions.map((text, i) => (
                <div
                  key={i}
                  id={`suggestion-${id}-${i}`}
                  role="option"
                  aria-selected={i === selectedSuggestionIndex}
                  className={`px-3 py-1.5 text-sm cursor-pointer truncate ${
                    i === selectedSuggestionIndex
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-900 dark:text-blue-300'
                      : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700'
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectSuggestion(text)}
                  onMouseEnter={() => setSelectedSuggestionIndex(i)}
                >
                  {text}
                </div>
              ))}
            </div>
          )}
        </div>

        {showAssignUI && (() => {
          const assigneeDisplayName = assignedUser
            ? [assignedUser.first_name, assignedUser.last_name].filter(Boolean).join(' ') || assignedUser.username
            : '?';
          return (
          <div className={`relative flex-shrink-0 ${item.assignedTo || !isCompleted ? 'ml-1' : ''}`}>
            {item.assignedTo ? (
              readOnly ? (
                <div
                  title={t('note.assignedTo', { name: assigneeDisplayName })}
                  aria-label={t('note.assignedTo', { name: assigneeDisplayName })}
                  className="rounded-full"
                >
                  <LetterAvatar
                    firstName={assignedUser?.first_name}
                    username={assignedUser?.username || '?'}
                    userId={item.assignedTo}
                    hasProfileIcon={assignedUser?.has_profile_icon}
                    iconVersion={assignedUser?.updated_at}
                    className="w-5 h-5"
                  />
                </div>
              ) : (
                <button
                  onClick={() => setShowAssigneePicker(true)}
                  title={t('note.assignedTo', { name: assigneeDisplayName })}
                  aria-label={t('note.assignedTo', { name: assigneeDisplayName })}
                  className={`rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800 ${isCompleted ? 'cursor-default' : 'cursor-pointer'}`}
                  disabled={isCompleted}
                >
                  <LetterAvatar
                    firstName={assignedUser?.first_name}
                    username={assignedUser?.username || '?'}
                    userId={item.assignedTo}
                    hasProfileIcon={assignedUser?.has_profile_icon}
                    iconVersion={assignedUser?.updated_at}
                    className="w-5 h-5"
                  />
                </button>
              )
            ) : (
              !isCompleted && !readOnly && (
                <button
                  onClick={() => setShowAssigneePicker(true)}
                  className={`w-5 h-5 rounded-full border border-dashed border-gray-300 dark:border-gray-400 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${ROW_REVEAL_CLASSES}`}
                  title={t('note.assignItem')}
                  aria-label={t('note.assignItem')}
                >
                  <UserPlus className="h-3 w-3 text-gray-400 dark:text-gray-300" aria-hidden="true" />
                </button>
              )
            )}
            {showAssigneePicker && !readOnly && (
              <AssigneePicker
                collaborators={collaborators}
                currentAssigneeId={item.assignedTo}
                onAssign={(userId) => onAssignItem(item.id, userId)}
                onClose={closeAssigneePicker}
              />
            )}
          </div>
          );
        })()}
      </div>

      {!readOnly && (
      <button
        onClick={() => onRemoveListItem(item.id)}
        aria-label={t('note.removeItem')}
        title={t('note.removeItem')}
        data-testid="list-item-delete"
        className={`ml-auto w-5 h-5 flex-shrink-0 flex items-center justify-center rounded text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-100 transition-opacity ${ROW_REVEAL_CLASSES}`}
      >
        <X className="h-4 w-4" />
      </button>
      )}
    </div>
  );
}
