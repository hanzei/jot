import { act, renderHook } from '@testing-library/react-native';
import { usePendingActionIndicator } from '../src/screens/noteEditor/usePendingActionIndicator';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';

// The menu-action pending bar (issue #697) is a small timing state machine: it
// only appears once an action has been slow for 600ms, then stays up for at
// least 300ms, and it has to survive overlapping actions without flickering.
// These exercise it directly — the screen tests cover that it's wired up, but
// the edges below are impractical to drive through a full editor render.

const DELAY_MS = 600;
const MIN_VISIBLE_MS = 300;

/** A promise the test resolves on demand, standing in for an in-flight write. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** `renderHook` publishes `result.current` from an effect, so flush once. */
async function mountIndicator() {
  const view = await renderHook(() => usePendingActionIndicator());
  await act(async () => {});
  return view;
}

describe('usePendingActionIndicator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    markServerReachable();
  });

  afterEach(() => {
    jest.useRealTimers();
    markServerReachable();
  });

  it('stays hidden for an action that finishes before the delay elapses', async () => {
    const { result } = await mountIndicator();
    const action = deferred<void>();

    const call = result.current.withPendingIndicator(() => action.promise);

    await act(async () => { jest.advanceTimersByTime(DELAY_MS - 1); });
    expect(result.current.isPending).toBe(false);

    await act(async () => { action.resolve(); await call; });
    expect(result.current.isPending).toBe(false);

    // The show-delay was cancelled, not merely outrun: letting the clock run
    // past it must not surface a bar for an action that already finished.
    await act(async () => { jest.advanceTimersByTime(DELAY_MS); });
    expect(result.current.isPending).toBe(false);
  });

  it('shows the bar once an action outlives the delay, and keeps it up for the minimum visible window', async () => {
    const { result } = await mountIndicator();
    const action = deferred<void>();

    const call = result.current.withPendingIndicator(() => action.promise);

    await act(async () => { jest.advanceTimersByTime(DELAY_MS); });
    expect(result.current.isPending).toBe(true);

    // Finishing right after the bar appeared must not blink it out a frame later.
    await act(async () => { action.resolve(); await call; });
    expect(result.current.isPending).toBe(true);

    await act(async () => { jest.advanceTimersByTime(MIN_VISIBLE_MS - 1); });
    expect(result.current.isPending).toBe(true);

    await act(async () => { jest.advanceTimersByTime(1); });
    expect(result.current.isPending).toBe(false);
  });

  it('hides only once every overlapping action has finished', async () => {
    const { result } = await mountIndicator();
    const first = deferred<void>();
    const second = deferred<void>();

    const firstCall = result.current.withPendingIndicator(() => first.promise);
    const secondCall = result.current.withPendingIndicator(() => second.promise);

    await act(async () => { jest.advanceTimersByTime(DELAY_MS); });
    expect(result.current.isPending).toBe(true);

    // One sibling finishing must not tear the bar down while the other is still
    // awaiting its write.
    await act(async () => { first.resolve(); await firstCall; });
    await act(async () => { jest.advanceTimersByTime(MIN_VISIBLE_MS * 2); });
    expect(result.current.isPending).toBe(true);

    await act(async () => { second.resolve(); await secondCall; });
    await act(async () => { jest.advanceTimersByTime(MIN_VISIBLE_MS); });
    expect(result.current.isPending).toBe(false);
  });

  it('does not show the bar while the server is already known unreachable', async () => {
    markServerUnreachable();
    const { result } = await mountIndicator();
    const action = deferred<void>();

    const call = result.current.withPendingIndicator(() => action.promise);

    // Nothing to wait for: the write underneath skips the network entirely, so
    // even a slow one gets no indicator.
    await act(async () => { jest.advanceTimersByTime(DELAY_MS * 2); });
    expect(result.current.isPending).toBe(false);

    await act(async () => { action.resolve(); await call; });
    expect(result.current.isPending).toBe(false);
  });

  it('propagates the action result and still settles the bar when it rejects', async () => {
    const { result } = await mountIndicator();

    await act(async () => {
      await expect(result.current.withPendingIndicator(() => Promise.resolve('done'))).resolves.toBe('done');
    });

    await act(async () => {
      await expect(result.current.withPendingIndicator(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    });

    await act(async () => { jest.advanceTimersByTime(DELAY_MS * 2); });
    expect(result.current.isPending).toBe(false);
  });

  it('does not update state after unmount when an action outlives the screen', async () => {
    const { result, unmount } = await mountIndicator();
    const action = deferred<void>();

    const call = result.current.withPendingIndicator(() => action.promise);

    unmount();

    // The armed show-delay must not fire a state update on an unmounted hook.
    await act(async () => { jest.advanceTimersByTime(DELAY_MS * 2); });
    await act(async () => { action.resolve(); await call; });
    await act(async () => { jest.advanceTimersByTime(MIN_VISIBLE_MS * 2); });
  });
});
