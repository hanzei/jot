import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import type { Note, User } from '@jot/shared';
import SortableNoteCard from './SortableNoteCard';
import { canAnimate } from '@/utils/motion';

const COLUMN_CLASS = 'columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-0';

const ENTER_DURATION_MS = 200;
const LEAVE_DURATION_MS = 150;

const EMPTY_IDS: ReadonlySet<string> = new Set();

interface AnimatedCardProps {
  /** Animate the card in on mount (only for cards genuinely added to a stable view). */
  animateEnter: boolean;
  leaving: boolean;
  onLeaveComplete: () => void;
  children: ReactNode;
}

/**
 * Wraps a single note card and animates it into and out of the grid with a
 * fade + slight scale/translate via the Web Animations API. When motion is
 * reduced or unavailable the card simply appears/disappears, and leaves resolve
 * immediately so the parent can drop it from the list.
 */
function AnimatedCard({ animateEnter, leaving, onLeaveComplete, children }: AnimatedCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const leaveStartedRef = useRef(false);

  // Animate in once when a freshly added card mounts. Cards that appear on the
  // first populate or a view/filter switch mount with `animateEnter = false` and
  // simply show, so navigation never animates a whole list in.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!animateEnter || !canAnimate(element)) return;

    animationRef.current = element.animate(
      [
        { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: ENTER_DURATION_MS, easing: 'ease-out' },
    );

    return () => {
      animationRef.current?.cancel();
      animationRef.current = null;
    };
    // Enter runs a single time on mount; animateEnter is fixed per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animate out once the parent marks the card as leaving, then notify so it can
  // be removed from the rendered list. Runs as a layout effect so the
  // non-animated removal is flushed before paint (no lingering frame).
  useLayoutEffect(() => {
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
  /** True only while the card animates out; otherwise it is a live card. */
  leaving: boolean;
  /** True for cards added to a stable view, so they animate in on mount. */
  entering: boolean;
}

interface ReconcileResult {
  entries: Entry[];
  /** Ids considered "established" — used to detect genuinely new cards next time. */
  knownIds: Set<string>;
}

/** Build the entry list for an instant swap (first populate or view change). */
function swap(notes: Note[]): ReconcileResult {
  return {
    entries: notes.map((note) => ({ note, leaving: false, entering: false })),
    knownIds: new Set(notes.map((note) => note.id)),
  };
}

/**
 * Reconcile rendered entries against incoming notes within the *same* view.
 * Cards whose ids are new animate in; cards that disappeared are kept around
 * (marked `leaving`) at their previous index so they can animate out — unless
 * they merely moved to another section (`presentElsewhere`), in which case they
 * are dropped instantly so the note never renders in two places at once.
 */
function reconcile(
  previous: Entry[],
  notes: Note[],
  knownIds: Set<string>,
  presentElsewhere: ReadonlySet<string>,
): ReconcileResult {
  const nextIds = new Set(notes.map((note) => note.id));
  const result: Entry[] = notes.map((note) => ({
    note,
    leaving: false,
    entering: !knownIds.has(note.id),
  }));

  const previousIndex = new Map(previous.map((entry, index) => [entry.note.id, index]));
  const departed = previous.filter(
    (entry) => !nextIds.has(entry.note.id) && !presentElsewhere.has(entry.note.id),
  );

  // Re-insert departed cards in their original order so positions stay stable
  // while they fade out.
  departed
    .sort((a, b) => (previousIndex.get(a.note.id) ?? 0) - (previousIndex.get(b.note.id) ?? 0))
    .forEach((entry) => {
      const index = Math.min(previousIndex.get(entry.note.id) ?? result.length, result.length);
      result.splice(index, 0, { note: entry.note, leaving: true, entering: false });
    });

  return { entries: result, knownIds: nextIds };
}

interface AnimatedNoteGridProps {
  notes: Note[];
  /**
   * Signature of the active view/filter/search. When it changes the grid swaps
   * instantly (no enter/leave), so only in-view changes (create, delete,
   * archive, restore, duplicate, pin, SSE sync) animate.
   */
  viewKey: string;
  /**
   * Ids of every note currently shown across all sections. A card that leaves
   * this section but is still in this set merely moved (e.g. pin/unpin between
   * the pinned and other sections) and is dropped instantly instead of
   * animating out, so it never appears in two sections at once.
   */
  presentElsewhere?: Set<string> | undefined;
  disabled: boolean;
  inBin: boolean;
  currentUserId?: string | undefined;
  usersById?: Map<string, User> | undefined;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: ((noteId: string) => Promise<void> | void) | undefined;
  onShare: (note: Note) => void;
  onRestore?: ((noteId: string) => void) | undefined;
  onPermanentlyDelete?: ((noteId: string) => void) | undefined;
  onRefresh?: (() => void) | undefined;
  onLabelClick?: ((labelId: string) => void) | undefined;
  /**
   * Notifies when the grid goes from rendering cards to rendering none (and
   * back). Lets the parent keep the section mounted while the last card animates
   * out, then drop it once the exit finishes.
   */
  onActiveChange?: ((active: boolean) => void) | undefined;
}

/**
 * Renders a sortable grid of note cards that animate as individual cards enter
 * and leave a stable view. The first populate and any view/filter/search change
 * swap instantly (guarded by `viewKey`); reordering is handled by dnd-kit via
 * SortableContext and never triggers an enter/leave.
 */
export default function AnimatedNoteGrid({
  notes,
  viewKey,
  presentElsewhere,
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
  onActiveChange,
}: AnimatedNoteGridProps) {
  const [state, setState] = useState<ReconcileResult>(() => swap(notes));
  // Track the inputs the current `state` was derived from so we can reconcile
  // during render (React's recommended pattern for deriving state from props).
  const [renderedNotes, setRenderedNotes] = useState(notes);
  const [renderedViewKey, setRenderedViewKey] = useState(viewKey);

  if (renderedViewKey !== viewKey) {
    // View/filter/search changed: swap instantly, no enter/leave.
    setRenderedViewKey(viewKey);
    setRenderedNotes(notes);
    setState(swap(notes));
  } else if (renderedNotes !== notes) {
    // Same view, notes changed: animate the delta.
    setRenderedNotes(notes);
    const elsewhere = presentElsewhere ?? EMPTY_IDS;
    setState((previous) => reconcile(previous.entries, notes, previous.knownIds, elsewhere));
  }

  const handleLeaveComplete = useCallback((id: string) => {
    setState((previous) => ({
      ...previous,
      entries: previous.entries.filter((entry) => !(entry.leaving && entry.note.id === id)),
    }));
  }, []);

  // Tell the parent whether any card (live or still animating out) is rendered,
  // so it can keep the section mounted until the last exit finishes.
  const active = state.entries.length > 0;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  return (
    <SortableContext items={state.entries.map((entry) => entry.note.id)} strategy={rectSortingStrategy}>
      <div className={COLUMN_CLASS}>
        {state.entries.map((entry) => (
          <AnimatedCard
            key={entry.note.id}
            animateEnter={entry.entering}
            leaving={entry.leaving}
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
