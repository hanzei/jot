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
      // below — and this wrapper sees every keypress that bubbles up out of the
      // card, including that button's, which would activate the drag twice.
      {...(!disabled ? { ...listeners, onKeyDown: undefined } : {})}
      className={`group select-none relative ${
        disabled ? 'cursor-default' : isDragging ? 'cursor-grabbing scale-105 shadow-xl' : 'cursor-grab'
      }`}
    >
      <div className="group" style={{ pointerEvents: isDragging ? 'none' : 'auto' }}>
        <NoteCard
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
        />
      </div>
      {!disabled && (
        // The keyboard half of dragging, and the only part of this that is a
        // new element on screen — invisible until it has focus, so a pointer
        // user never sees it and the grid looks exactly as it did.
        //
        // Last in the wrapper, so a card's tab order runs open → menu → labels
        // → reorder: the thing you almost always want is first, and reordering,
        // which is the rarest, is the one you tab past everything else to reach.
        //
        // `opacity-0` rather than `sr-only`: it has to be visible when focused
        // (WCAG 2.4.7) and `sr-only` positions the element itself, so undoing
        // it on focus means fighting over `position` with a second utility.
        // `pointer-events-none` keeps it out of the way of a drag that starts
        // on the pixels underneath it.
        //
        // `attributes` and `listeners` go on together: the KeyboardSensor
        // activates on keydown, so splitting them leaves a focusable element
        // that does nothing. Being the activator node is also what makes Space
        // unambiguous — dnd-kit ignores an activation keypress whose target is
        // not this button, so Space on the card still opens the note.
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={t('note.reorderNote')}
          title={t('note.reorderNote')}
          {...attributes}
          {...listeners}
          className="absolute bottom-2 right-2 z-20 flex items-center justify-center rounded bg-white dark:bg-slate-800 p-1 text-gray-600 dark:text-gray-200 shadow opacity-0 pointer-events-none focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <GripVertical className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}