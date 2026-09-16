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

  it('picks the card nearest `near` when a note is registered by two screens', async () => {
    const { result } = await renderHook(() => useCardRectRegistry(), { wrapper });
    const registry = result.current!;

    // The same note rendered by two mounted lists (e.g. Notes and My Tasks).
    registry.register('a', async () => rect(0));
    registry.register('a', async () => rect(100));

    await expect(registry.measure('a', rect(90))).resolves.toEqual(rect(100));
    await expect(registry.measure('a', rect(5))).resolves.toEqual(rect(0));
  });

  it('ignores measurers that resolve null and returns null when all do', async () => {
    const { result } = await renderHook(() => useCardRectRegistry(), { wrapper });
    const registry = result.current!;

    registry.register('a', async () => null);
    registry.register('a', async () => rect(7));
    await expect(registry.measure('a', rect(0))).resolves.toEqual(rect(7));

    registry.register('b', async () => null);
    await expect(registry.measure('b', rect(0))).resolves.toBeNull();
  });

  it('unregister removes only the given measurer, leaving others in place', async () => {
    const { result } = await renderHook(() => useCardRectRegistry(), { wrapper });
    const registry = result.current!;

    const first: CardRectMeasurer = async () => rect(0);
    const second: CardRectMeasurer = async () => rect(100);

    registry.register('a', first);
    registry.register('a', second);

    registry.unregister('a', first);
    await expect(registry.measure('a', rect(0))).resolves.toEqual(rect(100));

    registry.unregister('a', second);
    await expect(registry.measure('a', rect(0))).resolves.toBeNull();
  });

  it('returns null when used without a provider', async () => {
    const { result } = await renderHook(() => useCardRectRegistry());
    expect(result.current).toBeNull();
  });
});
