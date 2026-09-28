import { describe, it, expect } from 'vitest';
import { VALIDATION } from '../constants';
import type { ListItem } from '../listItems';
import { splitPasteIntoItems, type PasteSplitResult, type PasteSplitSuccess } from '../listPaste';

const item = (id: string, overrides: Partial<Omit<ListItem, 'id'>> = {}): ListItem => ({
  id,
  text: id,
  completed: false,
  position: 0,
  parentId: null,
  assigned_to: '',
  ...overrides,
});

const idGen = () => {
  let n = 0;
  return () => `new-${++n}`;
};

const noCaret = { before: '', after: '' };

const ok = (result: PasteSplitResult | null): PasteSplitSuccess => {
  if (!result || 'error' in result) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result;
};

const texts = (items: ListItem[]) => items.map(it => it.text);

describe('splitPasteIntoItems', () => {
  it('splits lines into new items after the target and normalizes positions', () => {
    const items = [item('a'), item('b', { position: 1 })];
    const result = ok(splitPasteIntoItems(items, 0, 'one\ntwo\nthree', noCaret, idGen()));

    expect(texts(result.items)).toEqual(['one', 'two', 'three', 'b']);
    expect(result.items.map(it => it.position)).toEqual([0, 1, 2, 3]);
    expect(result.items[0]!.id).toBe('a');
    expect(result.insertedIds).toEqual(['new-1', 'new-2']);
    expect(result.caretItemId).toBe('new-2');
    expect(result.caretOffset).toBe('three'.length);
  });

  it('keeps the text before and after the caret around the pasted lines', () => {
    const items = [item('a', { text: 'headtail' })];
    const result = ok(splitPasteIntoItems(items, 0, 'x\ny', { before: 'head', after: 'tail' }, idGen()));

    expect(texts(result.items)).toEqual(['headx', 'ytail']);
    expect(result.caretItemId).toBe('new-1');
    expect(result.caretOffset).toBe(1);
  });

  it('keeps the after-caret text when the paste collapses to one line', () => {
    const items = [item('a', { text: 'headtail' })];
    const result = ok(splitPasteIntoItems(items, 0, '# \n- x\n', { before: 'head', after: 'tail' }, idGen()));

    expect(texts(result.items)).toEqual(['headxtail']);
    expect(result.insertedIds).toEqual([]);
    expect(result.caretItemId).toBe('a');
    expect(result.caretOffset).toBe('headx'.length);
  });

  it('replaces the selection with nothing when no line is usable', () => {
    const items = [item('a', { text: 'keep' })];
    const result = ok(splitPasteIntoItems(items, 0, '\n  \n# \n- \n', { before: 'ke', after: 'ep' }, idGen()));

    expect(texts(result.items)).toEqual(['keep']);
    expect(result.insertedIds).toEqual([]);
  });

  it('strips markdown markers and carries the completed state', () => {
    const items = [item('a')];
    const result = ok(splitPasteIntoItems(items, 0, '- [ ] too\n- [x] bar\n1. baz', noCaret, idGen()));

    expect(texts(result.items)).toEqual(['too', 'bar', 'baz']);
    expect(result.items.map(it => it.completed)).toEqual([false, true, false]);
  });

  it('keeps every line completed when pasting into a completed item', () => {
    const items = [item('a', { completed: true })];
    const result = ok(splitPasteIntoItems(items, 0, '- [ ] too\nbar', noCaret, idGen()));

    expect(texts(result.items)).toEqual(['too', 'bar']);
    expect(result.items.map(it => it.completed)).toEqual([true, true]);
  });

  it('puts the new items in the target item\'s group', () => {
    const items = [
      item('p'),
      item('c1', { parentId: 'p' }),
      item('c2', { parentId: 'p' }),
    ];
    const result = ok(splitPasteIntoItems(items, 1, 'x\ny', noCaret, idGen()));

    expect(result.items.map(it => it.id)).toEqual(['p', 'c1', 'new-1', 'c2']);
    expect(result.items.map(it => it.parentId)).toEqual([null, 'p', 'p', 'p']);
  });

  it('places top-level lines pasted into a parent after its group', () => {
    const items = [item('p'), item('c', { parentId: 'p' }), item('z')];
    const result = ok(splitPasteIntoItems(items, 0, 'x\ny', noCaret, idGen()));

    expect(result.items.map(it => it.id)).toEqual(['p', 'c', 'new-1', 'z']);
    expect(result.items.find(it => it.id === 'new-1')!.parentId).toBeNull();
  });

  it('truncates every line to the item length cap', () => {
    const long = 'a'.repeat(VALIDATION.ITEM_TEXT_MAX_LENGTH + 10);
    const items = [item('a', { text: '' })];
    const result = ok(splitPasteIntoItems(items, 0, `${long}\n${long}`, { before: '', after: 'tail' }, idGen()));

    for (const it of result.items) {
      expect(it.text).toHaveLength(VALIDATION.ITEM_TEXT_MAX_LENGTH);
    }
    expect(result.caretOffset).toBe(VALIDATION.ITEM_TEXT_MAX_LENGTH);
  });

  it('rejects a paste that would exceed the item count cap without generating IDs', () => {
    const items = [item('a'), item('b')];
    const lines = Array.from({ length: VALIDATION.ITEM_MAX_COUNT }, (_, i) => `line ${i}`).join('\n');
    let generated = 0;
    const result = splitPasteIntoItems(items, 0, lines, noCaret, () => `id-${++generated}`);

    expect(result).toEqual({ error: 'tooManyItems', max: VALIDATION.ITEM_MAX_COUNT });
    expect(generated).toBe(0);
  });

  it('accepts a paste that lands exactly on the item count cap', () => {
    const items = [item('a'), item('b')];
    // Target line + (ITEM_MAX_COUNT - 2) inserted = ITEM_MAX_COUNT total.
    const lines = Array.from({ length: VALIDATION.ITEM_MAX_COUNT - 1 }, (_, i) => `line ${i}`).join('\n');
    const result = ok(splitPasteIntoItems(items, 0, lines, noCaret, idGen()));

    expect(result.items).toHaveLength(VALIDATION.ITEM_MAX_COUNT);
  });

  it('does not reject a single-line paste into a note already at the cap', () => {
    const items = Array.from({ length: VALIDATION.ITEM_MAX_COUNT }, (_, i) => item(`i${i}`));
    const result = ok(splitPasteIntoItems(items, 0, '- x\n', noCaret, idGen()));

    expect(result.items[0]!.text).toBe('x');
  });

  it('handles CRLF and CR line endings', () => {
    const items = [item('a')];
    const result = ok(splitPasteIntoItems(items, 0, 'one\r\ntwo\rthree', noCaret, idGen()));

    expect(texts(result.items)).toEqual(['one', 'two', 'three']);
  });

  it('returns null for an out-of-range target', () => {
    expect(splitPasteIntoItems([item('a')], 3, 'x\ny', noCaret, idGen())).toBeNull();
  });
});
