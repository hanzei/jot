import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyToClipboard } from '../useCopyToClipboard';

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('useCopyToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves true and sets copied when the Clipboard API writes', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    mockClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.copy('hello'); });

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(result.current.copied).toBe(true);
  });

  it('resolves true through the execCommand fallback', async () => {
    mockClipboard(() => Promise.reject(new Error('denied')));
    document.execCommand = vi.fn(() => true);
    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.copy('hello'); });

    expect(ok).toBe(true);
    expect(result.current.copied).toBe(true);
  });

  it('resolves false and leaves copied unset when both ways fail', async () => {
    mockClipboard(() => Promise.reject(new Error('denied')));
    document.execCommand = vi.fn(() => false);
    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.copy('hello'); });

    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });
});
