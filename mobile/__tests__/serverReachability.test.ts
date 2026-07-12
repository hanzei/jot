import {
  isServerReachable,
  markServerReachable,
  markServerUnreachable,
  subscribeToServerReachability,
  getServerReachabilityChangedAt,
} from '../src/api/serverReachability';

describe('serverReachability', () => {
  afterEach(() => {
    // Reset to the default so state doesn't leak between cases.
    markServerReachable();
  });

  it('defaults to reachable', () => {
    expect(isServerReachable()).toBe(true);
  });

  it('flips to unreachable and back', () => {
    markServerUnreachable();
    expect(isServerReachable()).toBe(false);
    markServerReachable();
    expect(isServerReachable()).toBe(true);
  });

  it('notifies subscribers only on an actual transition', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToServerReachability((reachable) => seen.push(reachable));

    markServerReachable(); // already reachable — no transition, no callback
    markServerUnreachable(); // true -> false
    markServerUnreachable(); // no-op
    markServerReachable(); // false -> true

    expect(seen).toEqual([false, true]);
    unsubscribe();

    markServerUnreachable();
    expect(seen).toEqual([false, true]); // no further callbacks after unsubscribe
  });

  it('records the timestamp of the last transition, but not a no-op call', () => {
    markServerUnreachable();
    const firstChange = getServerReachabilityChangedAt();
    expect(firstChange).not.toBeNull();

    // A redundant call (already unreachable) must not bump the timestamp.
    markServerUnreachable();
    expect(getServerReachabilityChangedAt()).toBe(firstChange);

    markServerReachable();
    const secondChange = getServerReachabilityChangedAt();
    expect(secondChange).not.toBeNull();
  });
});
