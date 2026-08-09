import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { X, UserPlus, GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, type User, type Collaborator } from '@jot/shared';
import LetterAvatar from '@/components/LetterAvatar';
import AssigneePicker from '@/components/AssigneePicker';
import { indentOf, type ListItem } from '@/utils/noteItems';
import { renderInlineItem } from '@/utils/markdown';
import { sourceOffsetAtPoint } from '@/utils/inlineCaret';
import { canAnimate } from '@/utils/motion';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Per-row controls (delete, assign) are hidden until the row is hovered
// (desktop) or a field within it is focused (works on touch). While hidden the
// control is also non-interactive, so an invisible button can't be tapped by
// accident — important on touch devices, where there's no hover to reveal it.
export const ROW_REVEAL_CLASSES =
  'opacity-0 pointer-events-none group-hover/item:opacity-100 group-hover/item:pointer-events-auto group-focus-within/item:opacity-100 group-focus-within/item:pointer-events-auto';

// Everything that decides how much vertical space a line of item text takes:
// width, padding, and how it wraps. The rendered view and the textarea it stands
// in for must carry all of it, or the row changes height on the swap for no
// reason other than the two forms being laid out differently.
//
// `block` is the one that is not obvious, and it is here to take the line box
// out of the question rather than to match it. A textarea is an `inline-block`
// by default, so it sits on a baseline and the line box around it reserves
// descender space underneath — and *how much* is a property of the platform's
// font and its UA stylesheet, not of anything in this file. Reproducing that on
// a span is possible (`overflow` moves a baseline to the bottom margin edge,
// CSS 2.1 §10.8.1) and was the first fix here, but it only held on the font it
// was measured against: on Windows the textarea did not reserve the space and
// the span did, so every row grew ~7px the moment it lost focus.
//
// Blocks have no baseline to disagree about. Both boxes are then `lines ×
// line-height + padding` from the same inherited metrics, which is equal by
// construction on any platform. It also costs each row the descender space it
// used to carry, so list rows are that much tighter than before — accidental
// spacing, not designed, and now gone in both states rather than one.
const TEXT_LAYOUT_CLASSES = 'block w-full pt-0 pb-1 pl-1 pr-0 whitespace-pre-wrap break-words';

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
  // Focused and editing are the same state, deliberately: the row shows its
  // Markdown rendered until you put the caret in it, and shows source for
  // exactly as long as the caret is there. That is what keeps every keystroke
  // handler below on a real textarea, with no render-mode duplicate of Tab,
  // Enter or the suggestion arrows — and no focusable non-interactive element
  // for a screen reader or axe to trip over.
  const [isEditing, setIsEditing] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const listItemTextRef = useRef<HTMLTextAreaElement | null>(null);
  const renderedRef = useRef<HTMLSpanElement>(null);
  const textColumnRef = useRef<HTMLDivElement>(null);
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
  // Kept as one string shared by both forms of the row rather than reasoned
  // about twice: whatever a completed row looks like today, the rendered view
  // and the textarea have to look the same as each other.
  const textToneClasses = `text-gray-900 dark:text-white ${
    isCompleted ? 'line-through text-gray-500 dark:text-gray-400' : ''
  }`;
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

  // Links are live exactly where there is no caret to place. A read-only row is
  // a display surface like the note card, so its links work; an editable row's
  // do not, because one click there already means "put the caret here" and a
  // second meaning on the same pixel has no way to resolve itself. See
  // docs/specs/markdown-rendering.md §1.2.
  const rendered = useMemo(
    () => renderInlineItem(item.text, { links: readOnly }),
    [item.text, readOnly],
  );

  // A row only swaps when rendering actually changes what is on screen. `buy
  // milk` renders to `buy milk`, so a list with no Markdown in it keeps the
  // always-live textarea it has always had, and pays for none of this.
  const showRendered = rendered.formatted && (readOnly || !isEditing);
  // Nothing to place a caret with, and no editing to return to: the bin's rows
  // drop the textarea entirely rather than hiding a focusable copy of the text
  // behind the rendered one, which would be both an extra tab stop and a second
  // announcement of the same item.
  const showTextarea = !(readOnly && showRendered);

  // Height is measured before the swap and animated to afterwards. The two
  // forms of a row wrap at different points once markers are involved, so a row
  // can genuinely change height — and an unannounced change moves every row
  // below it out from under the pointer.
  const heightBeforeSwapRef = useRef<number | null>(null);
  const captureSwapHeight = useCallback(() => {
    heightBeforeSwapRef.current = textColumnRef.current?.getBoundingClientRect().height ?? null;
  }, []);

  const wasShowingRendered = useRef(showRendered);
  useLayoutEffect(() => {
    if (wasShowingRendered.current === showRendered) return;
    wasShowingRendered.current = showRendered;

    const from = heightBeforeSwapRef.current;
    heightBeforeSwapRef.current = null;
    const column = textColumnRef.current;
    if (from === null || !canAnimate(column)) return;

    const to = column.getBoundingClientRect().height;
    // Sub-pixel differences are the common case — same content, same wrap — and
    // animating those is a frame of work to move nothing.
    if (Math.abs(to - from) < 1) return;
    column.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 120,
      easing: 'ease-out',
    });
  }, [showRendered]);

  // Entering edit mode from a click has to place the caret itself: the browser
  // would put it where the point falls in the *source*, and the user pointed at
  // the rendered text.
  const editFromPoint = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    const textarea = listItemTextRef.current;
    const container = renderedRef.current;
    if (!textarea || !container) return;
    e.preventDefault();
    captureSwapHeight();
    const offset = sourceOffsetAtPoint(container, rendered.nodes, item.text, e.clientX, e.clientY);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
  }, [captureSwapHeight, item.text, rendered.nodes]);

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

  // A highlight must not outlive the list it points into. `suggestions` is
  // derived from `completedItemTexts`, which changes whenever an item is
  // completed or un-completed — including by a collaborator over SSE, with no
  // keystroke in this field to reset the index. The same index can then mean a
  // different suggestion (a same-length replacement) or none at all (a shrink),
  // and a shrink that later re-expands makes a stale index valid again.
  //
  // Keyed on the suggestion *text* rather than the array identity: `items` gets
  // a fresh identity on every edit and autosave pass, so an identity check
  // would drop the user's highlight mid-interaction for a list that did not
  // actually change.
  const suggestionsKey = suggestions.join(' ');
  const [highlightedFor, setHighlightedFor] = useState(suggestionsKey);
  if (highlightedFor !== suggestionsKey) {
    setHighlightedFor(suggestionsKey);
    setSelectedSuggestionIndex(-1);
  }

  const suggestionsVisible = showSuggestions && suggestions.length > 0;

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
          // Grabbing the grip must not move focus off the row's textarea. If it
          // did, the row would collapse to its rendered form on mousedown —
          // changing its height in the same tick the PointerSensor activates and
          // dnd-kit measures, so the drag would run against a rect for a height
          // the row no longer has. Preventing the default keeps the caret where
          // it was and the row the size dnd-kit measured.
          //
          // Only the mouse path needs this. A keyboard drag arrives by Tab, so
          // the row has already collapsed and settled before Space starts it.
          onMouseDown={(e) => e.preventDefault()}
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
        <div ref={textColumnRef} className="relative min-w-0 flex-1">
          {showTextarea && (
          <textarea
            data-testid="list-item-input"
            placeholder={placeholder}
            rows={1}
            autoCapitalize="sentences"
            readOnly={readOnly}
            aria-readonly={readOnly}
            // Never unmounted while the row is editable, only moved out of flow
            // and faded out. Everything that reaches for a row imperatively —
            // NoteModal's Enter-to-split, arrow navigation and "add item" focus,
            // all of which go through `inputRef` — keeps working on a row that
            // happens to be showing its rendered form, and the height the
            // textarea comes up at was measured while it was on screen rather
            // than at the moment of focus.
            //
            // `opacity-0` rather than `invisible` or `hidden`: both of those
            // take an element out of the focus order, and `.focus()` on one
            // silently does nothing.
            className={`${TEXT_LAYOUT_CLASSES} bg-transparent border-none outline-none min-w-0 resize-none overflow-hidden placeholder-gray-500 dark:placeholder-gray-400 ${textToneClasses} ${
              showRendered ? 'absolute top-0 left-0 opacity-0 pointer-events-none' : ''
            }`}
            value={item.text}
            onInput={(e) => autoResizeListItemText(e.currentTarget)}
            onChange={readOnly ? undefined : (e) => {
              onUpdateListItem(index, 'text', e.target.value);
              if (e.target.value.trim()) setShowSuggestions(true);
              setSelectedSuggestionIndex(-1);
            }}
            onFocus={readOnly ? undefined : () => {
              captureSwapHeight();
              setIsEditing(true);
              if (suggestions.length > 0) setShowSuggestions(true);
            }}
            onBlur={(e) => {
              const related = e.relatedTarget as Node | null;
              // Focus moving into the dropdown is still editing this row, so the
              // row must not collapse out from under the option being clicked.
              if (suggestionsRef.current?.contains(related)) return;
              captureSwapHeight();
              setIsEditing(false);
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
            aria-controls={suggestionsVisible ? `suggestions-${id}` : undefined}
            // Tied to the entry existing, not just to a non-negative index: an
            // id pointing at an option that is not rendered is a dangling
            // reference for a screen reader.
            aria-activedescendant={
              suggestionsVisible && suggestions[selectedSuggestionIndex] !== undefined
                ? `suggestion-${id}-${selectedSuggestionIndex}`
                : undefined
            }
            onKeyDown={readOnly ? undefined : (e) => {
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
          )}
          {showRendered && (
            <span
              ref={renderedRef}
              data-testid="list-item-rendered"
              // The textarea behind it is the row's real control and carries the
              // accessible name and the value, so this is decoration for anyone
              // not looking at it — except on a read-only row, where there is no
              // textarea and these links are the only way to reach the targets.
              aria-hidden={showTextarea ? true : undefined}
              onMouseDown={showTextarea ? editFromPoint : undefined}
              className={`markdown-inline ${TEXT_LAYOUT_CLASSES} ${textToneClasses} ${
                showTextarea ? 'cursor-text' : ''
              }`}
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
          )}
          {suggestionsVisible && !isCompleted && !readOnly && (
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
