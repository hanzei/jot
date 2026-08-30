import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Note, User } from '@jot/shared';
import NoteCard from './NoteCard';

interface SortableNoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: ((noteId: string) => Promise<void> | void) | undefined;
  onShare: (note: Note) => void;
  onRestore?: ((noteId: string) => void) | undefined;
  onPermanentlyDelete?: ((noteId: string) => void) | undefined;
  currentUserId?: string | undefined;
  usersById?: Map<string, User> | undefined;
  disabled?: boolean;
  inBin?: boolean;
  onRefresh?: (() => void) | undefined;
  onLabelClick?: ((labelId: string) => void) | undefined;
  /** Whether this card holds the grid's one roving-tabindex stop (#950). */
  isActive: boolean;
  onCardFocus: (noteId: string) => void;
}

export default function SortableNoteCard({
  note,
  onEdit,
  onDelete,
  onDuplicate,
  onShare,
  onRestore,
  onPermanentlyDelete,
  currentUserId,
  usersById,
  disabled = false,
  inBin = false,
  onRefresh,
  onLabelClick,
  isActive,
  onCardFocus,
}: SortableNoteCardProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: note.id,
    disabled: disabled
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : 1,
    zIndex: isDragging ? 1000 : 'auto',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-drag-disabled={disabled ? 'true' : 'false'}
      // `attributes` is deliberately not spread here. It is what put
      // role="button" and tabIndex={0} on this wrapper, which made every card a
      // control wrapping the card's own controls (#799) and cost a second tab
      // stop per card. Dropping it costs nothing a pointer user can see: axe's
      // nested-interactive only matches elements that resolve to an interactive
      // role, and the pointer sensors activate on mousedown/touchstart, which a
      // plain div receives just as well.
      //
      // `onKeyDown` is withheld for a different reason. The KeyboardSensor is
      // the one sensor that needs focus, so it lives on the reorder button
      // passed in as `dragHandle` — and this wrapper sees every keypress that
      // bubbles up out of the card, including that button's, which would
      // otherwise activate the drag a second time.
      {...(!disabled ? { ...listeners, onKeyDown: undefined } : {})}
      className={`group select-none relative ${
        disabled ? 'cursor-default' : isDragging ? 'cursor-grabbing scale-105 shadow-xl' : 'cursor-grab'
      }`}
    >
      <div className="group" style={{ pointerEvents: isDragging ? 'none' : 'auto' }}>
        <NoteCard
          dragHandle={!disabled && (
            // The keyboard half of dragging, and the only part of this that is
            // a new element on screen — invisible until it has focus, so a
            // pointer user never sees it and the grid looks exactly as it did.
            //
            // `opacity-0` rather than `sr-only`: it has to be visible when
            // focused (WCAG 2.4.7) and `sr-only` positions the element itself,
            // so undoing it on focus means fighting over `position` with a
            // second utility. `pointer-events-none` keeps it out of the way of
            // a drag that starts on the pixels underneath it — and it is why
            // this does not reveal on hover the way the menu does: a pointer
            // user can already drag from anywhere on the card, so a visible
            // grip would be decoration.
            //
            // `attributes` and `listeners` go on together: the KeyboardSensor
            // activates on keydown, so splitting them leaves a focusable
            // element that does nothing. Being the activator node is also what
            // makes Space unambiguous — dnd-kit ignores an activation keypress
            // whose target is not this button, so Space on the card still
            // opens the note.
            <button
              type="button"
              ref={setActivatorNodeRef}
              aria-label={t('note.reorderNote')}
              title={t('note.reorderNote')}
              {...attributes}
              {...listeners}
              // Roving tabindex (#950): out of the Tab sequence for every card
              // but the active one, or the per-card tab-stop count this issue
              // exists to collapse only shrinks from three to two. Reachable by
              // `.focus()` regardless — dnd-kit's own keyboard tests and the
              // arrow-key/Home/End navigation both call it directly rather than
              // relying on Tab, so this costs them nothing.
              tabIndex={isActive ? 0 : -1}
              // Same backdrop as the overflow menu beside it: a fixed-colour
              // icon over an arbitrary cover image has no guaranteed contrast
              // (WCAG 1.4.11), so both controls carry a translucent chip rather
              // than relying on the image behind them.
              //
              // Reveals on `group-focus-within` — whenever any control in the
              // card holds focus — so highlighting the card shows the grip and
              // the menu together, rather than the grip only appearing once it
              // is itself tabbed to. It stays hidden on hover, unlike the menu:
              // a mouse can already drag from anywhere on the card, so a grip
              // revealed to the pointer would be decoration.
              className="absolute top-2 right-9 z-20 p-1 rounded-full bg-white/80 dark:bg-slate-900/70 text-gray-700 dark:text-gray-200 shadow-sm opacity-0 pointer-events-none group-focus-within:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          note={note}
          onEdit={onEdit}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onShare={onShare}
          onRestore={onRestore}
          onPermanentlyDelete={onPermanentlyDelete}
          currentUserId={currentUserId}
          usersById={usersById}
          inBin={inBin}
          onRefresh={onRefresh}
          onLabelClick={onLabelClick}
          isActive={isActive}
          onCardFocus={onCardFocus}
        />
      </div>
    </div>
  );
}