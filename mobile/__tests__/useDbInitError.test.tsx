import { act, renderHook } from '@testing-library/react-native';
import { useDbInitError } from '../src/hooks/useDbInitError';

describe('useDbInitError', () => {
  it('reports an error for the current instance', async () => {
    const { result } = await renderHook(({ instance }: { instance: string }) => useDbInitError(instance), {
      initialProps: { instance: 'sqlite-a-0' },
    });

    expect(result.current.hasError).toBe(false);
    await act(() => result.current.reportError(new Error('open failed')));
    expect(result.current.hasError).toBe(true);
  });

  it('clears the error when a retry or server switch mounts a new instance', async () => {
    const { result, rerender } = await renderHook(({ instance }: { instance: string }) => useDbInitError(instance), {
      initialProps: { instance: 'sqlite-a-0' },
    });

    await act(() => result.current.reportError(new Error('open failed')));
    expect(result.current.hasError).toBe(true);

    await rerender({ instance: 'sqlite-a-1' });
    expect(result.current.hasError).toBe(false);
  });

  it('keeps the current instance’s error when a stale instance reports afterwards', async () => {
    const { result, rerender } = await renderHook(({ instance }: { instance: string }) => useDbInitError(instance), {
      initialProps: { instance: 'sqlite-a-0' },
    });

    // Instance A's provider is mounted and holds this callback. It is about to
    // be unmounted by a server switch, but its init promise is still pending —
    // so this reference stays live and can fire later.
    const reportFromA = result.current.reportError;

    await rerender({ instance: 'sqlite-b-0' });
    await act(() => result.current.reportError(new Error('B failed')));
    expect(result.current.hasError).toBe(true);

    // A's rejection finally lands, out of order. With a single error slot this
    // overwrote B's and dismissed the error screen while B's database was still
    // unusable; keyed by instance, it lands under A and B's error survives.
    await act(() => reportFromA(new Error('A failed, late')));
    expect(result.current.hasError).toBe(true);

    // And going back to A still shows A's error rather than having lost it.
    await rerender({ instance: 'sqlite-a-0' });
    expect(result.current.hasError).toBe(true);
  });
});
