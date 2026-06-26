import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import type { Note, User } from '@jot/shared';
import SortableNoteCard from './SortableNoteCard';
import { canAnimate } from '@/utils/motion';

const COLUMN_CLASS = 'columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-0';

const ENTER_DURATION_MS = 200;
const LEAVE_DURATION_MS = 150;
// Cap the staggered enter so a large grid still settles quickly on first load.
const STAGGER_STEP_MS = 25;
const STAGGER_MAX_MS = 250;

interface AnimatedCardProps {
  leaving: boolean;
  /** Delay before the enter animation starts (used to stagger initial load). */
  enterDelay: number;
  onLeaveComplete: () => void;
  children: ReactNode;
}

/**
 * Wraps a single note card and animates it into and out of the grid with a
 * fade + slight scale/translate via the Web Animations API. When motion is
 * reduced or unavailable the card simply appears/disappears, and leaves resolve
 * immediately so the parent can drop it from the list.
 */
function AnimatedCard({ leaving, enterDelay, onLeaveComplete, children }: AnimatedCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const leaveStartedRef = useRef(false);

  // Animate in once when the card first mounts.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!canAnimate(element)) return;

    animationRef.current = element.animate(
      [
        { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: ENTER_DURATION_MS, delay: enterDelay, easing: 'ease-out', fill: 'backwards' },
    );

    return () => {
      animationRef.current?.cancel();
      animationRef.current = null;
    };
    // Enter runs a single time on mount; enterDelay is fixed per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animate out once the parent marks the card as leaving, then notify so it can
  // be removed from the rendered list.
  useEffect(() => {
    if (!leaving) {
      // The card was re-added while leaving (e.g. delete then "Undo"). Cancel
      // the in-flight exit so it snaps back to fully visible.
      if (leaveStartedRef.current) {
        leaveStartedRef.current = false;
        animationRef.current?.cancel();
        animationRef.current = null;
      }
      return;
    }
    if (leaveStartedRef.current) return;
    leaveStartedRef.current = true;

    const element = ref.current;
    if (!canAnimate(element)) {
      onLeaveComplete();
      return;
    }

    animationRef.current?.cancel();
    const animation = element.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.96)' },
      ],
      { duration: LEAVE_DURATION_MS, easing: 'ease-in', fill: 'forwards' },
    );
    animationRef.current = animation;
    animation.onfinish = () => onLeaveComplete();
  }, [leaving, onLeaveComplete]);

  return (
    <div ref={ref} aria-hidden={leaving || undefined} style={leaving ? { pointerEvents: 'none' } : undefined}>
      {children}
    </div>
  );
}

interface Entry {
  note: Note;
  leaving: boolean;
}

/**
 * Reconcile the currently rendered entries against the incoming notes. Notes
 * that disappeared are kept around (marked `leaving`) at their previous index so
 * they can animate out before being dropped.
 */
function reconcile(previous: Entry[], notes: Note[]): Entry[] {
  const nextIds = new Set(notes.map((note) => note.id));
  const result: Entry[] = notes.map((note) => ({ note, leaving: false }));

  const previousIndex = new Map(previous.map((entry, index) => [entry.note.id, index]));
  const departed = previous.filter((entry) => !nextIds.has(entry.note.id));

  // Re-insert departed cards in their original order so positions stay stable
  // while they fade out.
  departed
    .sort((a, b) => (previousIndex.get(a.note.id) ?? 0) - (previousIndex.get(b.note.id) ?? 0))
    .forEach((entry) => {
      const index = Math.min(previousIndex.get(entry.note.id) ?? result.length, result.length);
      result.splice(index, 0, { note: entry.note, leaving: true });
    });

  return result;
}

interface AnimatedNoteGridProps {
  notes: Note[];
  disabled: boolean;
  inBin: boolean;
  currentUserId?: string;
  usersById?: Map<string, User>;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: (noteId: string) => Promise<void> | void;
  onShare: (note: Note) => void;
  onRestore?: (noteId: string) => void;
  onPermanentlyDelete?: (noteId: string) => void;
  onRefresh?: () => void;
  onLabelClick?: (labelId: string) => void;
}

/**
 * Renders a sortable grid of note cards that animate as they enter and leave.
 * Cards present on first mount are staggered in; cards added or removed later
 * fade individually. Reordering is still handled by dnd-kit via SortableContext.
 *
 * Switching views/filters should remount this grid (give it a `key` that
 * encodes the active view) so the new set staggers in cleanly instead of
 * cross-fading the whole list.
 */
export default function AnimatedNoteGrid({
  notes,
  disabled,
  inBin,
  currentUserId,
  usersById,
  onEdit,
  onDelete,
  onDuplicate,
  onShare,
  onRestore,
  onPermanentlyDelete,
  onRefresh,
  onLabelClick,
}: AnimatedNoteGridProps) {
  const [entries, setEntries] = useState<Entry[]>(() => notes.map((note) => ({ note, leaving: false })));
  // Only cards present on first mount stagger in; later additions fade with no delay.
  const [initialIds] = useState<Set<string>>(() => new Set(notes.map((note) => note.id)));

  // Reconcile entries against incoming notes during render (React's recommended
  // pattern for deriving state from props), keeping departed cards around to
  // animate out.
  const [renderedNotes, setRenderedNotes] = useState(notes);
  if (renderedNotes !== notes) {
    setRenderedNotes(notes);
    setEntries((previous) => reconcile(previous, notes));
  }

  const handleLeaveComplete = useCallback((id: string) => {
    setEntries((previous) => previous.filter((entry) => !(entry.leaving && entry.note.id === id)));
  }, []);

  return (
    <SortableContext items={entries.map((entry) => entry.note.id)} strategy={rectSortingStrategy}>
      <div className={COLUMN_CLASS}>
        {entries.map((entry, index) => (
          <AnimatedCard
            key={entry.note.id}
            leaving={entry.leaving}
            enterDelay={
              initialIds.has(entry.note.id)
                ? Math.min(index * STAGGER_STEP_MS, STAGGER_MAX_MS)
                : 0
            }
            onLeaveComplete={() => handleLeaveComplete(entry.note.id)}
          >
            <SortableNoteCard
              note={entry.note}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onShare={onShare}
              onRestore={onRestore}
              onPermanentlyDelete={onPermanentlyDelete}
              currentUserId={currentUserId}
              usersById={usersById}
              disabled={entry.leaving || disabled}
              inBin={inBin}
              onRefresh={onRefresh}
              onLabelClick={onLabelClick}
            />
          </AnimatedCard>
        ))}
      </div>
    </SortableContext>
  );
}
