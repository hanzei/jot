import { packColumns, computeInsertionIndex, moveToIndex, type PlacedItem } from '../src/screens/notesList/masonry';

const opts = { columnWidth: 100, columnGap: 10, rowGap: 8, columns: 2 };

describe('packColumns', () => {
  it('places the first two cards side by side in separate columns', () => {
    const { placed } = packColumns(['a', 'b'], { a: 50, b: 60 }, opts);
    expect(placed[0]).toMatchObject({ id: 'a', column: 0, x: 0, y: 0, height: 50 });
    expect(placed[1]).toMatchObject({ id: 'b', column: 1, x: 110, y: 0, height: 60 });
  });

  it('stacks the next card under the currently shortest column', () => {
    // a(50) -> col0, b(60) -> col1; col0 is shorter so c stacks under a.
    const { placed } = packColumns(['a', 'b', 'c'], { a: 50, b: 60, c: 30 }, opts);
    expect(placed[2]).toMatchObject({ id: 'c', column: 0, x: 0, y: 50 + opts.rowGap });
  });

  it('uses the estimated height for unmeasured cards', () => {
    const { placed } = packColumns(['a'], {}, { ...opts, estimatedHeight: 200 });
    expect(placed[0].height).toBe(200);
  });

  it('reports the tallest column height without the trailing row gap', () => {
    const { containerHeight } = packColumns(['a', 'b', 'c'], { a: 50, b: 60, c: 30 }, opts);
    // col0: 50 + gap + 30 = 88; col1: 60. Tallest 88.
    expect(containerHeight).toBe(88);
  });

  it('returns zero height for an empty list', () => {
    expect(packColumns([], {}, opts).containerHeight).toBe(0);
  });
});

describe('computeInsertionIndex', () => {
  const placed: PlacedItem[] = packColumns(
    ['a', 'b', 'c', 'd'],
    { a: 50, b: 50, c: 50, d: 50 },
    opts,
  ).placed;
  // col0: a(y0,h50), c(y58,h50); col1: b(y0,h50), d(y58,h50)

  it('returns 0 for an empty list', () => {
    expect(computeInsertionIndex([], 5, 5, opts)).toBe(0);
  });

  it('inserts before the nearest card when the pointer is above its center', () => {
    // Pointer over column 0, just above card a's center (25).
    const idx = computeInsertionIndex(placed, 10, 10, opts);
    expect(idx).toBe(0);
  });

  it('inserts after the nearest column-0 card when the pointer is below its center', () => {
    // Pointer over column 0, well below card c (the last col-0 card, index 2),
    // so the active card is inserted right after it.
    const idx = computeInsertionIndex(placed, 10, 200, opts);
    expect(idx).toBe(3);
  });

  it('prefers the column the pointer is over', () => {
    // Pointer over column 1 near card b -> nearest should be b (index 1).
    const idx = computeInsertionIndex(placed, 160, 10, opts);
    expect(idx).toBe(1);
  });
});

describe('moveToIndex', () => {
  it('moves an id forward', () => {
    expect(moveToIndex(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an id backward', () => {
    expect(moveToIndex(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('clamps an out-of-range target to the end', () => {
    expect(moveToIndex(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when the id stays in place', () => {
    expect(moveToIndex(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
  });
});
