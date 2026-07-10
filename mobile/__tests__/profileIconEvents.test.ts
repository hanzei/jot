import type { User } from '@jot/shared';
import { publishProfileIconUpdate, subscribeToProfileIconUpdates } from '../src/store/profileIconEvents';

const makeUser = (id: string): User =>
  ({ id, username: id, first_name: '', last_name: '', role: 'user', has_profile_icon: true, created_at: '', updated_at: '2024-01-01T00:00:00Z' } as User);

describe('profileIconEvents bus', () => {
  // The listener Set is module-level, so any subscription that outlives its test
  // would leak into the next one (e.g. making the no-subscriber case moot). Track
  // every unsubscribe and run them all after each test to keep the Set clean.
  const cleanups: Array<() => void> = [];
  const track = (unsubscribe: () => void) => {
    cleanups.push(unsubscribe);
    return unsubscribe;
  };

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('delivers published users to all current subscribers', () => {
    const a = jest.fn();
    const b = jest.fn();
    track(subscribeToProfileIconUpdates(a));
    track(subscribeToProfileIconUpdates(b));

    const user = makeUser('u1');
    publishProfileIconUpdate(user);

    expect(a).toHaveBeenCalledWith(user);
    expect(b).toHaveBeenCalledWith(user);
  });

  it('stops delivering after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = track(subscribeToProfileIconUpdates(listener));

    publishProfileIconUpdate(makeUser('u1'));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishProfileIconUpdate(makeUser('u2'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with no subscribers', () => {
    expect(() => publishProfileIconUpdate(makeUser('u1'))).not.toThrow();
  });
});
