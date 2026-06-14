import {
  retrySync,
  isTransientError,
  SyncAbortedError,
  SyncCanceller,
  SYNC_RETRY_MAX_ATTEMPTS,
} from '../src/utils/retryWithBackoff';

function makeAxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

// A network failure produces an Axios error with no `response` (no HTTP status).
function makeNetworkError() {
  return Object.assign(new Error('Network Error'), { isAxiosError: true });
}

describe('isTransientError', () => {
  it('treats network errors (no response) as transient', () => {
    expect(isTransientError(makeNetworkError())).toBe(true);
  });

  it.each([408, 429, 500, 502, 503])('treats HTTP %i as transient', (status) => {
    expect(isTransientError(makeAxiosError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 410, 422])('treats HTTP %i as permanent', (status) => {
    expect(isTransientError(makeAxiosError(status))).toBe(false);
  });

  it('does not retry a 401 (session cleared by the interceptor)', () => {
    expect(isTransientError(makeAxiosError(401))).toBe(false);
  });

  it('treats non-axios errors as permanent (not retryable)', () => {
    expect(isTransientError(new Error('boom'))).toBe(false);
  });
});

describe('SyncCanceller', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sleep resolves after the timer elapses', async () => {
    const canceller = new SyncCanceller();
    const resolved = jest.fn();
    canceller.sleep(1000).then(resolved);

    await jest.advanceTimersByTimeAsync(999);
    expect(resolved).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalled();
  });

  it('cancel resolves an in-flight sleep immediately and flips cancelled', async () => {
    const canceller = new SyncCanceller();
    const resolved = jest.fn();
    canceller.sleep(60000).then(resolved);

    expect(canceller.cancelled).toBe(false);
    canceller.cancel();
    await Promise.resolve();
    expect(canceller.cancelled).toBe(true);
    expect(resolved).toHaveBeenCalled();
  });

  it('sleep resolves immediately when already cancelled', async () => {
    const canceller = new SyncCanceller();
    canceller.cancel();
    const resolved = jest.fn();
    canceller.sleep(60000).then(resolved);
    await Promise.resolve();
    expect(resolved).toHaveBeenCalled();
  });
});

describe('retrySync', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns the result on first success without sleeping', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retrySync(fn, { isConnected: () => true })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure with backoff, then succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce('ok');
    const canceller = new SyncCanceller();
    const promise = retrySync(fn, { isConnected: () => true, canceller, baseDelayMs: 1000 });

    // First attempt fails and enters the backoff sleep.
    await jest.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Backoff elapses → retry succeeds.
    await jest.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('grows the delay exponentially and caps it', async () => {
    const fn = jest.fn().mockRejectedValue(makeAxiosError(503));
    const promise = retrySync(fn, {
      isConnected: () => true,
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
    }).catch((e) => e);

    // Delays: attempt1→1000, attempt2→2000, attempt3→3000 (capped), attempt4→3000 (capped).
    await jest.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(5);

    await promise;
  });

  it('rethrows the original error once retries are exhausted', async () => {
    const err = makeAxiosError(500);
    const fn = jest.fn().mockRejectedValue(err);
    const promise = retrySync(fn, { isConnected: () => true, maxAttempts: 3, baseDelayMs: 1000 }).catch(
      (e) => e,
    );

    await jest.advanceTimersByTimeAsync(1000 + 2000);
    expect(await promise).toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent (4xx) error', async () => {
    const err = makeAxiosError(404);
    const fn = jest.fn().mockRejectedValue(err);
    const result = await retrySync(fn, { isConnected: () => true }).catch((e) => e);
    expect(result).toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately with SyncAbortedError("offline") when offline at start', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retrySync(fn, { isConnected: () => false }).catch((e) => e);
    expect(result).toBeInstanceOf(SyncAbortedError);
    expect((result as SyncAbortedError).reason).toBe('offline');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops with SyncAbortedError("offline") when connectivity drops after a transient failure', async () => {
    let connected = true;
    const fn = jest.fn().mockRejectedValue(makeNetworkError());
    const promise = retrySync(fn, {
      isConnected: () => connected,
      baseDelayMs: 1000,
    }).catch((e) => e);

    await jest.advanceTimersByTimeAsync(0); // first attempt fails, enters backoff
    connected = false; // device goes offline during the backoff
    await jest.advanceTimersByTimeAsync(1000); // backoff elapses; loop sees offline
    const result = await promise;
    expect(result).toBeInstanceOf(SyncAbortedError);
    expect((result as SyncAbortedError).reason).toBe('offline');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight backoff when cancelled', async () => {
    const fn = jest.fn().mockRejectedValue(makeAxiosError(503));
    const canceller = new SyncCanceller();
    const promise = retrySync(fn, { isConnected: () => true, canceller, baseDelayMs: 1000 }).catch(
      (e) => e,
    );

    await jest.advanceTimersByTimeAsync(0); // first attempt fails, enters sleep
    canceller.cancel();
    await jest.advanceTimersByTimeAsync(0); // sleep resolves, loop observes cancel

    const result = await promise;
    expect(result).toBeInstanceOf(SyncAbortedError);
    expect((result as SyncAbortedError).reason).toBe('cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('defaults to a bounded number of attempts', async () => {
    const fn = jest.fn().mockRejectedValue(makeNetworkError());
    const promise = retrySync(fn, { isConnected: () => true, baseDelayMs: 1000 }).catch((e) => e);
    // Advance well past the cap to drain every backoff.
    await jest.advanceTimersByTimeAsync(60000 * SYNC_RETRY_MAX_ATTEMPTS);
    await promise;
    expect(fn).toHaveBeenCalledTimes(SYNC_RETRY_MAX_ATTEMPTS);
  });
});
