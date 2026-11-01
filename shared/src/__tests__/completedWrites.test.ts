import { describe, expect, it } from 'vitest';
import { completedCascadeScope, createCompletedWriteTracker } from '../completedWrites';

const items = [
  { id: 'p', parentId: null },
  { id: 'c1', parentId: 'p' },
  { id: 'c2', parentId: 'p' },
  { id: 'solo', parentId: null },
];

describe('completedCascadeScope', () => {
  it('covers a top-level item and all of its children, in either direction', () => {
    expect(completedCascadeScope(items, 'p', true)).toEqual(['p', 'c1', 'c2']);
    expect(completedCascadeScope(items, 'p', false)).toEqual(['p', 'c1', 'c2']);
  });

  it('covers a child alone when checked, and its parent too when unchecked', () => {
    expect(completedCascadeScope(items, 'c1', true)).toEqual(['c1']);
    expect(completedCascadeScope(items, 'c1', false)).toEqual(['c1', 'p']);
  });

  it('is empty for an unknown item', () => {
    expect(completedCascadeScope(items, 'missing', true)).toEqual([]);
  });
});

describe('createCompletedWriteTracker', () => {
  it('hands an item to the most recent write that claimed it', () => {
    const tracker = createCompletedWriteTracker();
    const first = tracker.begin(['p', 'c1']);
    const second = tracker.begin(['c1']);

    expect(tracker.owns(first, 'p')).toBe(true);
    expect(tracker.owns(first, 'c1')).toBe(false);
    expect(tracker.owns(second, 'c1')).toBe(true);
    expect(tracker.owns(second, 'p')).toBe(false);
  });

  it('releases only the items a write still owns when it ends', () => {
    const tracker = createCompletedWriteTracker();
    const first = tracker.begin(['a', 'b']);
    const second = tracker.begin(['b']);

    tracker.end(first);
    expect(tracker.owns(first, 'a')).toBe(false);
    expect(tracker.owns(second, 'b')).toBe(true);

    tracker.end(second);
    expect(tracker.owns(second, 'b')).toBe(false);
  });

  it('lets a new write claim an item an ended write released', () => {
    const tracker = createCompletedWriteTracker();
    tracker.end(tracker.begin(['a']));
    const next = tracker.begin(['a']);
    expect(tracker.owns(next, 'a')).toBe(true);
  });
});
