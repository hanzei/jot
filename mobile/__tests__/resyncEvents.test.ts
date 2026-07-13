import { publishReconnectResync, subscribeToReconnectResync } from '../src/store/resyncEvents';

describe('resyncEvents bus', () => {
  // The listener Set is module-level, so any subscription that outlives its test
  // would leak into the next one. Track every unsubscribe and run them all after
  // each test to keep the Set clean.
  const cleanups: Array<() => void> = [];
  const track = (unsubscribe: () => void) => {
    cleanups.push(unsubscribe);
    return unsubscribe;
  };

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('notifies all current subscribers on publish', () => {
    const a = jest.fn();
    const b = jest.fn();
    track(subscribeToReconnectResync(a));
    track(subscribeToReconnectResync(b));

    publishReconnectResync();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = track(subscribeToReconnectResync(listener));

    publishReconnectResync();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishReconnectResync();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with no subscribers', () => {
    expect(() => publishReconnectResync()).not.toThrow();
  });
});
