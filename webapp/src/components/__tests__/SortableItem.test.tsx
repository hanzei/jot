import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type ReactNode } from 'react';
import SortableItem from '../SortableItem';
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
