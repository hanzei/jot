import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import AnimatedNoteGrid from '../AnimatedNoteGrid';
import type { Note } from '@jot/shared';
import { createMockTextNote } from '@/utils/__tests__/test-helpers';

// Render a lightweight stand-in for each card so the test focuses on the
// enter/leave lifecycle rather than NoteCard internals.
vi.mock('../SortableNoteCard', () => ({
  default: ({ note, disabled }: { note: Note; disabled?: boolean }) => (
    <div data-testid={`card-${note.id}`} data-disabled={disabled ? 'true' : 'false'}>
      {note.note_type === 'text' ? note.content : note.title}
    </div>
  ),
}));

const baseProps = {
  disabled: false,
  inBin: false,
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onShare: vi.fn(),
};

const renderGrid = (notes: Note[], viewKey = 'notes', presentElsewhere?: Set<string>) =>
  render(
    <DndContext>
      <AnimatedNoteGrid notes={notes} viewKey={viewKey} presentElsewhere={presentElsewhere} {...baseProps} />
    </DndContext>,
  );

const rerenderGrid = (
  rerender: ReturnType<typeof renderGrid>['rerender'],
  notes: Note[],
  viewKey = 'notes',
  presentElsewhere?: Set<string>,
) =>
  rerender(
    <DndContext>
      <AnimatedNoteGrid notes={notes} viewKey={viewKey} presentElsewhere={presentElsewhere} {...baseProps} />
    </DndContext>,
  );

const note = (id: string) => createMockTextNote({ id, content: `note ${id}` });

describe('AnimatedNoteGrid', () => {
  it('renders a card for each note', () => {
    renderGrid([note('a'), note('b'), note('c')]);

    expect(screen.getByTestId('card-a')).toBeInTheDocument();
    expect(screen.getByTestId('card-b')).toBeInTheDocument();
    expect(screen.getByTestId('card-c')).toBeInTheDocument();
  });

  it('removes a card immediately when the Web Animations API is unavailable', async () => {
    // jsdom does not implement element.animate, so leaves resolve synchronously.
    const { rerender } = renderGrid([note('a'), note('b')]);

    rerenderGrid(rerender, [note('a')]);

    await waitFor(() => expect(screen.queryByTestId('card-b')).not.toBeInTheDocument());
    expect(screen.getByTestId('card-a')).toBeInTheDocument();
  });

  it('adds a new card when notes grow', () => {
    const { rerender } = renderGrid([note('a')]);

    rerenderGrid(rerender, [note('a'), note('b')]);

    expect(screen.getByTestId('card-a')).toBeInTheDocument();
    expect(screen.getByTestId('card-b')).toBeInTheDocument();
  });

  it('swaps instantly when the view changes', () => {
    const { rerender } = renderGrid([note('a'), note('b')], 'notes');

    rerenderGrid(rerender, [note('c'), note('d')], 'archive');

    // The new view's cards render and the old ones are gone right away — no
    // card is held back to animate out.
    expect(screen.getByTestId('card-c')).toBeInTheDocument();
    expect(screen.getByTestId('card-d')).toBeInTheDocument();
    expect(screen.queryByTestId('card-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-b')).not.toBeInTheDocument();
  });

  describe('with the Web Animations API available', () => {
    let animations: Array<{ onfinish: null | (() => void); cancel: ReturnType<typeof vi.fn> }>;
    let originalAnimate: typeof HTMLElement.prototype.animate;

    beforeEach(() => {
      animations = [];
      // jsdom does not implement animate; install a controllable stub and keep
      // the original (undefined) reference so afterEach can restore it.
      originalAnimate = HTMLElement.prototype.animate;
      HTMLElement.prototype.animate = function animate() {
        const animation = { onfinish: null as null | (() => void), cancel: vi.fn() };
        animations.push(animation);
        return animation as unknown as Animation;
      };
    });

    afterEach(() => {
      HTMLElement.prototype.animate = originalAnimate;
    });

    it('does not animate cards in on the first populate', () => {
      renderGrid([note('a'), note('b')]);

      expect(animations).toHaveLength(0);
    });

    it('does not animate cards in when the view changes', () => {
      const { rerender } = renderGrid([note('a')], 'notes');

      rerenderGrid(rerender, [note('b'), note('c')], 'archive');

      expect(animations).toHaveLength(0);
    });

    it('animates in only cards added to a stable view', () => {
      const { rerender } = renderGrid([note('a')]);
      expect(animations).toHaveLength(0);

      rerenderGrid(rerender, [note('a'), note('b')]);

      // Exactly one enter animation: the newly added card 'b'.
      expect(animations).toHaveLength(1);
    });

    it('drops a card instantly (no exit animation) when it moves to another section', () => {
      // 'b' leaves this section but is still shown elsewhere (e.g. pin/unpin
      // between the pinned and other sections), so it must not linger here.
      const { rerender } = renderGrid([note('a'), note('b')], 'notes');

      rerenderGrid(rerender, [note('a')], 'notes', new Set(['a', 'b']));

      expect(screen.queryByTestId('card-b')).not.toBeInTheDocument();
      expect(animations).toHaveLength(0);
    });

    it('keeps a leaving card mounted (and non-draggable) until its exit animation finishes', async () => {
      const { rerender } = renderGrid([note('a'), note('b')]);

      rerenderGrid(rerender, [note('a')]);

      // The card is still rendered while it animates out, but disabled so it
      // cannot be dragged on its way out.
      const leavingCard = screen.getByTestId('card-b');
      expect(leavingCard).toHaveAttribute('data-disabled', 'true');

      // Completing the exit animation drops the card from the grid.
      const leaveAnimation = animations[animations.length - 1]!;
      act(() => leaveAnimation.onfinish?.());

      await waitFor(() => expect(screen.queryByTestId('card-b')).not.toBeInTheDocument());
      expect(screen.getByTestId('card-a')).toBeInTheDocument();
    });

    it('cancels the exit and restores a card that is re-added mid-leave (undo)', () => {
      const { rerender } = renderGrid([note('a'), note('b')]);

      rerenderGrid(rerender, [note('a')]);
      const leaveAnimation = animations[animations.length - 1]!;
      expect(screen.getByTestId('card-b')).toHaveAttribute('data-disabled', 'true');

      // Re-add the card before its exit animation finishes.
      rerenderGrid(rerender, [note('a'), note('b')]);

      expect(leaveAnimation.cancel).toHaveBeenCalled();
      expect(screen.getByTestId('card-b')).toHaveAttribute('data-disabled', 'false');
    });
  });
});
