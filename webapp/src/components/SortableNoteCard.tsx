import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Note, User } from '@jot/shared';
import { useTranslation } from 'react-i18next';
import NoteCard from './NoteCard';

interface SortableNoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onShare: (note: Note) => void;
  onRestore?: (noteId: string) => void;
  onPermanentlyDelete?: (noteId: string) => void;
  currentUserId?: string;
  usersById?: Map<string, User>;
  disabled?: boolean;
  inBin?: boolean;
  onRefresh?: () => void;
}

export default function SortableNoteCard({
  note,
  onEdit,
  onDelete,
  onShare,
  onRestore,
  onPermanentlyDelete,
  currentUserId,
  usersById,
  disabled = false,
  inBin = false,
  onRefresh,
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
    disabled,
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
      className={`select-none relative group ${isDragging ? 'scale-105 shadow-xl' : ''}`}
    >
      {!disabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
          className={`absolute top-2 left-2 min-h-6 min-w-6 inline-flex items-center justify-center p-1 touch-none opacity-0 group-hover:opacity-100 focus:opacity-100 touch-visible transition-opacity z-20 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800 ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          title={t('dashboard.dragToReorder')}
          aria-label={t('dashboard.dragToReorder')}
        >
          <span className="block h-1 w-5 rounded-full bg-current/70" aria-hidden="true" />
        </button>
      )}

      <div style={{ pointerEvents: isDragging ? 'none' : 'auto' }}>
        <NoteCard
          note={note}
          onEdit={onEdit}
          onDelete={onDelete}
          onShare={onShare}
          onRestore={onRestore}
          onPermanentlyDelete={onPermanentlyDelete}
          currentUserId={currentUserId}
          usersById={usersById}
          inBin={inBin}
          onRefresh={onRefresh}
        />
      </div>
    </div>
  );
}