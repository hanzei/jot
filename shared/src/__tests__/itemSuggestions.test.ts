import { describe, it, expect, vi } from 'vitest';
import {
  MAX_ITEM_SUGGESTIONS,
  distinctCompletedTexts,
  findSuggestedItem,
  itemSuggestions,
  reviveSuggestedItem,
} from '../itemSuggestions';
import type { ListItem } from '../listItems';

const item = (id: string, overrides: Partial<Omit<ListItem, 'id'>> = {}): ListItem => ({
  id,
  text: id,
  completed: false,
  position: 0,
  parentId: null,
  assigned_to: '',
  ...overrides,
});

const eligible = { startedEmpty: true, hasChildren: false };

describe('distinctCompletedTexts', () => {
  it('keeps completed texts in order, trimmed, first spelling winning', () => {
    const texts = distinctCompletedTexts([
      item('a', { text: '  Milk ', completed: true }),
      item('b', { text: 'Bread' }),
      item('c', { text: 'milk', completed: true }),
      item('d', { text: 'Eggs', completed: true }),
    ]);
    expect(texts).toEqual(['Milk', 'Eggs']);
  });

  it('skips blank completed items', () => {
    expect(distinctCompletedTexts([item('a', { text: '   ', completed: true })])).toEqual([]);
  });
});

describe('itemSuggestions', () => {
  const texts = ['Buy milk', 'Buy bread', 'buy'];

  it('matches anywhere in the text, ignoring case, but not an exact match', () => {
    expect(itemSuggestions(' BUY ', texts, eligible)).toEqual(['Buy milk', 'Buy bread']);
    expect(itemSuggestions('read', texts, eligible)).toEqual(['Buy bread']);
  });

  it('offers none for blank text', () => {
    expect(itemSuggestions('  ', texts, eligible)).toEqual([]);
  });

  it(`caps the list at ${MAX_ITEM_SUGGESTIONS}`, () => {
    const many = Array.from({ length: 8 }, (_, i) => `item ${i}`);
    expect(itemSuggestions('item', many, eligible)).toHaveLength(MAX_ITEM_SUGGESTIONS);
  });

  it('offers none on a row that was not empty when focused', () => {
    expect(itemSuggestions('buy', texts, { startedEmpty: false, hasChildren: false })).toEqual([]);
  });

  it('offers none on a row with sub-items', () => {
    expect(itemSuggestions('buy', texts, { startedEmpty: true, hasChildren: true })).toEqual([]);
  });
});

describe('findSuggestedItem', () => {
  it('finds the first completed item with that text, ignoring case and padding', () => {
    const items = [
      item('active', { text: 'Milk' }),
      item('first', { text: ' milk ', completed: true }),
      item('second', { text: 'Milk', completed: true }),
    ];
    expect(findSuggestedItem(items, 'Milk')?.id).toBe('first');
  });

  it('returns undefined when no completed item matches', () => {
    expect(findSuggestedItem([item('a', { text: 'Milk' })], 'Milk')).toBeUndefined();
  });
});

describe('reviveSuggestedItem', () => {
  // An editor's item state as the hooks see it, recording each step.
  const editor = (initial: ListItem[], uncheckResult: boolean) => {
    let items = initial;
    const steps: string[] = [];
    const hooks = {
      read: () => items,
      commit: (next: ListItem[]) => {
        items = next;
        steps.push(`commit:${next.map(it => it.id).join(',')}`);
      },
      uncheck: vi.fn((id: string) => {
        steps.push(`uncheck:${id}`);
        return Promise.resolve(uncheckResult);
      }),
      save: () => { steps.push('save'); },
    };
    return { hooks, steps, items: () => items };
  };
  const list = () => [item('a'), item('typing', { text: 'mil' }), item('milk', { text: 'Milk', completed: true })];

  it('moves the item into the typed row, unchecks it, then saves', async () => {
    const { hooks, steps } = editor(list(), true);
    await reviveSuggestedItem('typing', 'milk', hooks);
    expect(steps).toEqual(['commit:a,milk', 'uncheck:milk', 'save']);
  });

  it('puts the typed row back before saving when the uncheck fails', async () => {
    const { hooks, steps, items } = editor(list(), false);
    await reviveSuggestedItem('typing', 'milk', hooks);
    expect(steps).toEqual(['commit:a,milk', 'uncheck:milk', 'commit:a,typing,milk', 'save']);
    expect(items().find(it => it.id === 'typing')?.text).toBe('mil');
  });
});
