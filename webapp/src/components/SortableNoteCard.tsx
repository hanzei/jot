import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bars3Icon } from '@heroicons/react/24/outline';
import type { Note, UserInfo } from '@jot/shared';
import NoteCard from './NoteCard';

interface SortableNoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: (noteId: string) => Promise<void> | void;
  onShare: (note: Note) => void;
  onRestore?: (noteId: string) => void;
  onPermanentlyDelete?: (noteId: string) => void;
  currentUserId?: string;
  usersById?: ReadonlyMap<string, UserInfo>;
  disabled?: boolean;
  inBin?: boolean;
  onRefresh?: () => void;
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
}: SortableNoteCardProps) {
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
      className={`group touch-none select-none relative cursor-default ${
        isDragging ? 'scale-105 shadow-xl' : ''
      }`}
    >
      {/* Dedicated drag handle - only show for non-disabled notes */}
      {!disabled && (
        <div
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="absolute top-2 right-10 p-2 rounded-md bg-gray-100 dark:bg-slate-700 opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-slate-600 transition-all cursor-grab active:cursor-grabbing z-20"
        >
          <Bars3Icon className="h-4 w-4 text-gray-600 dark:text-gray-300" />
        </div>
      )}

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
        />
      </div>
    </div>
  );
}