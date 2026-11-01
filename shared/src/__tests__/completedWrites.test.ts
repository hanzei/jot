import { describe, expect, it } from 'vitest';
import { compareServerTimestamps, createCompletedWriteTracker } from '../completedWrites';

// Server timestamps as Go encodes them: RFC 3339, fraction trimmed of zeros.
const T0 = '2026-11-01T07:00:00Z';
const T1 = '2026-11-01T07:00:01.5Z';
const T2 = '2026-11-01T07:00:01.500001Z';

const prior = (entries: Record<string, boolean>) => new Map(Object.entries(entries));
const item = (id: string, completed: boolean, updatedAt?: string) =>
  ({ id, completed, ...(updatedAt === undefined ? {} : { updated_at: updatedAt }) });

describe('compareServerTimestamps', () => {
  it('orders fractions of different lengths numerically, not lexically', () => {
    expect(compareServerTimestamps(T1, T2)).toBeLessThan(0);
    expect(compareServerTimestamps(T2, T1)).toBeGreaterThan(0);
    expect(compareServerTimestamps(T0, T1)).toBeLessThan(0);
    expect(compareServerTimestamps('2026-11-01T07:00:01.50Z', T1)).toBe(0);
  });

  it('honours zone offsets', () => {
    expect(compareServerTimestamps('2026-11-01T08:00:00+01:00', T0)).toBe(0);
  });

  it('returns null for an unreadable timestamp', () => {
    expect(compareServerTimestamps('yesterday', T0)).toBeNull();
  });
});

describe('createCompletedWriteTracker', () => {
  it('skips an item a later write still claims', () => {
    const tracker = createCompletedWriteTracker();
    const a = tracker.begin(prior({ a: false }));
    tracker.begin(prior({ b: false }));

    // A's response predates B's write and still reports B unchecked.
    const accepted = tracker.accept(a, [item('a', true, T1), item('b', false, T0)]);
    expect(accepted).toEqual(new Map([['a', true]]));
  });

  it('answers a stale snapshot with the newest value seen', () => {
    const tracker = createCompletedWriteTracker();
    const a = tracker.begin(prior({ a: false }));
    const b = tracker.begin(prior({ b: false }));

    // B's response lands first; A's, read before B's write, lands last.
    expect(tracker.accept(b, [item('a', true, T1), item('b', true, T2)])).toEqual(
      new Map([['a', true], ['b', true]]),
    );
    tracker.end(b);
    expect(tracker.accept(a, [item('a', true, T1), item('b', false, T0)])).toEqual(
      new Map([['a', true], ['b', true]]),
    );
  });

  it('takes an item it never claimed when the snapshot is the newest word on it', () => {
    const tracker = createCompletedWriteTracker();
    const p = tracker.begin(prior({ p: false }));
    // The server cascaded to a child the client did not know was nested.
    expect(tracker.accept(p, [item('p', true, T1), item('c', true, T1)])).toEqual(
      new Map([['p', true], ['c', true]]),
    );
  });

  it('takes an item without a readable timestamp as it stands, unless a later write claims it', () => {
    const tracker = createCompletedWriteTracker();
    const a = tracker.begin(prior({ a: false }));
    tracker.begin(prior({ d: false }));
    expect(tracker.accept(a, [item('a', true), item('b', false), item('c', false, 'soon'), item('d', false)])).toEqual(
      new Map([['a', true], ['b', false], ['c', false]]),
    );
  });

  it('does not order items no local write has claimed', () => {
    const tracker = createCompletedWriteTracker();
    expect(tracker.accept(null, [item('x', true, T2)])).toEqual(new Map([['x', true]]));
    // Untracked, so an older snapshot is taken as it stands.
    expect(tracker.accept(null, [item('x', false, T1)])).toEqual(new Map([['x', false]]));
  });

  it('lets a snapshot that answers no write set only unclaimed items', () => {
    const tracker = createCompletedWriteTracker();
    tracker.begin(prior({ a: false }));
    expect(tracker.accept(null, [item('a', false, T0), item('b', true, T0)])).toEqual(
      new Map([['b', true]]),
    );
  });

  it('still records what a skipped item said, so an older snapshot cannot undo it', () => {
    const tracker = createCompletedWriteTracker();
    const early = tracker.begin(prior({ a: false }));
    const late = tracker.begin(prior({ a: true }));
    // The server applied `late` first and `early` last, so early's response is
    // the newest state — but late still claims the item, so it is skipped.
    expect(tracker.accept(early, [item('a', true, T2)])).toEqual(new Map());
    tracker.end(early);
    // Late's own response predates early's write: it yields the newer value.
    expect(tracker.accept(late, [item('a', false, T1)])).toEqual(new Map([['a', true]]));
  });

  it('reverts a failed write to the value it replaced', () => {
    const tracker = createCompletedWriteTracker();
    const a = tracker.begin(prior({ a: false, c: true }));
    expect(tracker.fail(a)).toEqual(new Map([['a', false], ['c', true]]));
    // Settled: a second end is a no-op and nothing is claimed any more.
    tracker.end(a);
    expect(tracker.accept(null, [item('a', true, T0)])).toEqual(new Map([['a', true]]));
  });

  it('unwinds two overlapping failures to where the item was before either', () => {
    const tracker = createCompletedWriteTracker();
    const check = tracker.begin(prior({ a: false }));
    const uncheck = tracker.begin(prior({ a: true }));

    // The later write fails first and falls back to the earlier one's value...
    expect(tracker.fail(uncheck)).toEqual(new Map([['a', true]]));
    // ...then the earlier one fails and the item returns to its original state.
    expect(tracker.fail(check)).toEqual(new Map([['a', false]]));
  });

  it('hands a failed earlier write\'s prior to the later write that superseded it', () => {
    const tracker = createCompletedWriteTracker();
    const check = tracker.begin(prior({ a: false }));
    const uncheck = tracker.begin(prior({ a: true }));

    // The earlier write fails while the later one is still in flight: nothing
    // to revert yet, since the later write's value is the one on screen.
    expect(tracker.fail(check)).toEqual(new Map());
    // When the later one fails too, the item goes back to before the first tap.
    expect(tracker.fail(uncheck)).toEqual(new Map([['a', false]]));
  });

  it('reports whether a later write has claimed an item since', () => {
    const tracker = createCompletedWriteTracker();
    const first = tracker.begin(prior({ a: false, b: false }));
    const second = tracker.begin(prior({ b: true }));
    expect(tracker.decides(first, 'a')).toBe(true);
    expect(tracker.decides(first, 'b')).toBe(false);
    expect(tracker.decides(second, 'b')).toBe(true);
    tracker.end(second);
    expect(tracker.decides(first, 'b')).toBe(true);
  });
});
