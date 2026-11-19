import { describe, it, expect } from 'vitest';
import { idRange, runSequentially } from '../noteBatch';

describe('runSequentially', () => {
  it('runs one item at a time, in order', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await runSequentially(['a', 'b', 'c'], async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      order.push(item);
      inFlight--;
    });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxInFlight).toBe(1);
  });

  it('keeps going after a failure and reports the first error', async () => {
    const first = new Error('first');
    const result = await runSequentially([1, 2, 3, 4], async (n) => {
      if (n === 2) throw first;
      if (n === 4) throw new Error('second');
    });
    expect(result.succeeded).toEqual([1, 3]);
    expect(result.failed).toEqual([2, 4]);
    expect(result.firstError).toBe(first);
  });
});

describe('idRange', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  it('returns the inclusive range in list order, whichever end is the anchor', () => {
    expect(idRange(ids, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(idRange(ids, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(idRange(ids, 'c', 'c')).toEqual(['c']);
  });

  it('returns null when an end is missing', () => {
    expect(idRange(ids, 'x', 'b')).toBeNull();
    expect(idRange(ids, 'b', 'x')).toBeNull();
  });
});
