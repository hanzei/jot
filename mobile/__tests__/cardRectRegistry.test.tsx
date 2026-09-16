import React from 'react';
import { renderHook } from '@testing-library/react-native';
import {
  CardRectRegistryProvider,
  useCardRectRegistry,
  type CardRectMeasurer,
} from '../src/screens/notesList/cardRectRegistry';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CardRectRegistryProvider>{children}</CardRectRegistryProvider>
);

const rect = (x: number) => ({ x, y: 0, width: 10, height: 10 });

describe('cardRectRegistry', () => {
  it('measures the registered card and null for an unknown id', async () => {
    const { result } = await renderHook(() => useCardRectRegistry(), { wrapper });
    const registry = result.current!;

    registry.register('a', async () => rect(1));

    await expect(registry.measure('a')).resolves.toEqual(rect(1));
    await expect(registry.measure('missing')).resolves.toBeNull();
  });

  it('replaces a measurer when the same id registers again', async () => {
    const { result } = await renderHook(() => useCardRectRegistry(), { wrapper });
    const registry = result.current!;

    registry.register('a', async () => rect(1));
    registry.register('a', async () => rect(2));

    await expect(registry.measure('a')).resolves.toEqual(rect(2));
  });

  it('unregister removes only the measurer it still owns', async () => {
    const { result } = await renderHook(() => useCardRectRegistry(), { wrapper });
    const registry = result.current!;

    const first: CardRectMeasurer = async () => rect(1);
    const second: CardRectMeasurer = async () => rect(2);

    // A remount registers `second` before the old card's cleanup runs; the
    // stale `first` cleanup must not wipe the live `second`.
    registry.register('a', first);
    registry.register('a', second);
    registry.unregister('a', first);

    await expect(registry.measure('a')).resolves.toEqual(rect(2));

    registry.unregister('a', second);
    await expect(registry.measure('a')).resolves.toBeNull();
  });

  it('returns null when used without a provider', async () => {
    const { result } = await renderHook(() => useCardRectRegistry());
    expect(result.current).toBeNull();
  });
});
