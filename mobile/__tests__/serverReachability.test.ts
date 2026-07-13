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
    jest.useRealTimers();
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
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    markServerUnreachable();
    const firstChange = getServerReachabilityChangedAt();
    expect(firstChange).not.toBeNull();

    // A redundant call (already unreachable) must not bump the timestamp.
    markServerUnreachable();
    expect(getServerReachabilityChangedAt()).toBe(firstChange);

    jest.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    markServerReachable();
    const secondChange = getServerReachabilityChangedAt();
    expect(secondChange).not.toBeNull();
    expect(secondChange).not.toBe(firstChange);
  });

  it('logs a transition (but not a no-op call) so a diagnostics report has a timeline, not just a snapshot', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    markServerUnreachable();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();

    // A redundant call (already unreachable) must not log again.
    markServerUnreachable();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    markServerReachable();
    expect(infoSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
