import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type ReactNode } from 'react';
import SortableItem, { type SortableItemProps } from '../SortableItem';
import type { ListItem } from '@/utils/noteItems';

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    setActivatorNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: vi.fn(() => '') } },
}));

const item: ListItem = {
  id: 'item-1',
  text: 'buy',
  completed: false,
  position: 0,
  parentId: null,
  assignedTo: '',
};

// The suggestion dropdown is driven entirely by `completedItemTexts`, which
// NoteModal recomputes from the note's items — so a collaborator completing or
// un-completing an item over SSE changes this prop with no keystroke in the
// field. Re-rendering with a new prop value is exactly that vector.
function renderItem(completedItemTexts: string[], onAcceptSuggestion = vi.fn()) {
  const utils = render(
    <SortableItem
      id="item-1"
      index={0}
      item={item}
      onUpdateListItem={vi.fn().mockResolvedValue(undefined)}
      onRemoveListItem={vi.fn()}
      completedItemTexts={completedItemTexts}
      onAcceptSuggestion={onAcceptSuggestion}
    />
  );
  const rerenderWith = (texts: string[]) =>
    utils.rerender(
      <SortableItem
        id="item-1"
        index={0}
        item={item}
        onUpdateListItem={vi.fn().mockResolvedValue(undefined)}
        onRemoveListItem={vi.fn()}
        completedItemTexts={texts}
        onAcceptSuggestion={onAcceptSuggestion}
      />
    );
  return { ...utils, rerenderWith, onAcceptSuggestion };
}

const input = () => screen.getByTestId('list-item-input');

/** Opens the dropdown and highlights the entry at `index` with ArrowDown. */
function highlight(index: number) {
  fireEvent.focus(input());
  for (let i = 0; i <= index; i++) {
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
  }
}

describe('SortableItem suggestion highlight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts the highlighted suggestion on Enter', () => {
    const { onAcceptSuggestion } = renderItem(['buy milk', 'buy bread']);

    highlight(1);
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onAcceptSuggestion).toHaveBeenCalledWith('item-1', 'buy bread');
  });

  it('drops a highlight when the suggestions are replaced at the same length', () => {
    const { rerenderWith, onAcceptSuggestion } = renderItem(['buy milk', 'buy bread']);

    highlight(1);
    // Same count, different entry at index 1 — the stale index still resolves,
    // so reading the entry alone would accept a suggestion never highlighted.
    rerenderWith(['buy milk', 'buy butter']);
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onAcceptSuggestion).not.toHaveBeenCalled();
  });

  it('drops a highlight across a shrink and re-expand', () => {
    const { rerenderWith, onAcceptSuggestion } = renderItem(['buy milk', 'buy bread', 'buy eggs']);

    highlight(2);
    // Out of range while shrunk, then in range again — but pointing at a
    // different entry than the one the user highlighted.
    rerenderWith(['buy milk']);
    rerenderWith(['buy milk', 'buy bread', 'buy butter']);
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onAcceptSuggestion).not.toHaveBeenCalled();
  });

  it('keeps the highlight when an unrelated re-render re-supplies the same suggestions', () => {
    const { rerenderWith, onAcceptSuggestion } = renderItem(['buy milk', 'buy bread']);

    highlight(1);
    // A fresh array with identical contents — NoteModal produces one on every
    // edit and autosave pass, and it must not cost the user their highlight.
    rerenderWith(['buy milk', 'buy bread']);
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onAcceptSuggestion).toHaveBeenCalledWith('item-1', 'buy bread');
  });

  it('only points aria-activedescendant at a suggestion that exists', () => {
    const { rerenderWith } = renderItem(['buy milk', 'buy bread']);

    expect(input()).not.toHaveAttribute('aria-activedescendant');

    highlight(1);
    expect(input()).toHaveAttribute('aria-activedescendant', 'suggestion-item-1-1');

    rerenderWith(['buy milk']);
    expect(input()).not.toHaveAttribute('aria-activedescendant');
  });
});

/**
 * The view/edit swap (docs/specs/markdown-rendering.md §1.2).
 *
 * These assert the *state machine* — which of the two forms is on screen, and
 * that the textarea survives the swap. What they cannot assert is the part that
 * needs a layout engine: the caret offset a click maps to, and the height the
 * row settles at. Both are covered in webapp/e2e/tests/markdown.spec.ts.
 */
describe('SortableItem rendered/source swap', () => {
  function renderRow(text: string, props: Partial<SortableItemProps> = {}) {
    return render(
      <SortableItem
        id="item-1"
        index={0}
        item={{ ...item, text }}
        onUpdateListItem={vi.fn().mockResolvedValue(undefined)}
        onRemoveListItem={vi.fn()}
        {...props}
      />
    );
  }

  const renderedView = () => screen.queryByTestId('list-item-rendered');
  const textarea = () => screen.queryByTestId('list-item-input');

  it('shows the rendered form of an unfocused row', () => {
    renderRow('buy **milk**');

    expect(renderedView()).toBeInTheDocument();
    expect(renderedView()!.innerHTML).toBe('buy <strong>milk</strong>');
    // The source is still in the field behind it, which is what every
    // imperative focus path in NoteModal reaches for.
    expect(textarea()).toHaveValue('buy **milk**');
  });

  it('shows source while the row is focused and renders again on blur', () => {
    renderRow('buy **milk**');

    fireEvent.focus(textarea()!);
    expect(renderedView()).not.toBeInTheDocument();

    fireEvent.blur(textarea()!);
    expect(renderedView()).toBeInTheDocument();
  });

  it('leaves a row with no Markdown in it alone', () => {
    // Nothing to show that the textarea is not already showing, so the row
    // keeps the always-live input it had before any of this.
    renderRow('buy milk');
    expect(renderedView()).not.toBeInTheDocument();
  });

  it('leaves block syntax and literal source alone too', () => {
    // Both render as themselves (§2.1), so neither is worth a swap.
    renderRow('# not a heading');
    expect(renderedView()).not.toBeInTheDocument();

    cleanup();
    renderRow('see ![alt](https://example.com/y.png)');
    expect(renderedView()).not.toBeInTheDocument();
  });

  it('renders an empty row as its placeholder, not as an empty span', () => {
    renderRow('');
    expect(renderedView()).not.toBeInTheDocument();
    expect(textarea()).toHaveAttribute('placeholder', 'List item...');
  });

  it('moves focus into the field when the rendered form is clicked', () => {
    renderRow('buy **milk**');

    fireEvent.mouseDown(renderedView()!);

    expect(textarea()).toHaveFocus();
    expect(renderedView()).not.toBeInTheDocument();
  });

  it('keeps rendering a completed row', () => {
    // Decision on #824 question 7: completed rows render, and the collision
    // between the row's line-through and ~~strike~~ is accepted (§2.1).
    renderRow('~~buy~~ milk', { isCompleted: true });
    expect(renderedView()!.innerHTML).toBe('<del>buy</del> milk');
  });

  it('drops the hidden field entirely on a read-only row', () => {
    // No caret to place, so a focusable copy of the text behind the rendered
    // one would be an extra tab stop announcing the same item twice.
    renderRow('buy **milk**', { readOnly: true });

    expect(renderedView()).toBeInTheDocument();
    expect(textarea()).not.toBeInTheDocument();
    expect(renderedView()).not.toHaveAttribute('aria-hidden');
  });

  it('links only on the row that has no caret to place', () => {
    renderRow('[docs](https://example.com)', { readOnly: true });
    expect(renderedView()!.querySelector('a')).not.toBeNull();

    cleanup();
    renderRow('[docs](https://example.com)');
    // Editable: one click already means "put the caret here", so the label
    // renders as text and nothing on the row looks followable.
    expect(renderedView()!.querySelector('a')).toBeNull();
    expect(renderedView()!.textContent).toBe('docs');
    expect(renderedView()).toHaveAttribute('aria-hidden', 'true');
  });
});
