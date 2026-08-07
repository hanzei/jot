import {
  packColumns,
  nearestCard,
  moveToIndex,
  reorderForPointer,
  type PlacedItem,
} from '../src/screens/notesList/masonry';

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
    expect(placed[0]!.height).toBe(200);
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

describe('nearestCard', () => {
  const placed: PlacedItem[] = packColumns(
    ['a', 'b', 'c', 'd'],
    { a: 50, b: 50, c: 50, d: 50 },
    opts,
  ).placed;
  // col0: a(y0,h50), c(y58,h50); col1: b(y0,h50), d(y58,h50)

  it('returns null for an empty list', () => {
    expect(nearestCard([], 5, 5, opts)).toBeNull();
  });

  it('returns the card nearest the pointer in its column', () => {
    expect(nearestCard(placed, 10, 10, opts)?.id).toBe('a');
    expect(nearestCard(placed, 10, 200, opts)?.id).toBe('c');
  });

  it('prefers the column the pointer is over', () => {
    expect(nearestCard(placed, 160, 10, opts)?.id).toBe('b');
    expect(nearestCard(placed, 160, 200, opts)?.id).toBe('d');
  });
});

describe('reorderForPointer', () => {
  // Single column to keep the slot math obvious: a(y0,h50), b(y58), c(y116), d(y174)
  const oneCol = { columnWidth: 100, columnGap: 10, rowGap: 8, columns: 1 };
  const order = ['a', 'b', 'c', 'd'];
  const placed = packColumns(order, { a: 50, b: 50, c: 50, d: 50 }, oneCol).placed;

  it('keeps the order unchanged while the pointer stays over the lifted card', () => {
    // Lift 'b' (center at 58 + 25 = 83) and hover its own slot.
    expect(reorderForPointer(order, placed, 'b', 10, 83, oneCol)).toEqual(order);
  });

  it('does not reorder for tiny movements that stay nearest the lifted card', () => {
    // Pointer drifts a little but is still closest to b's center.
    expect(reorderForPointer(order, placed, 'b', 10, 95, oneCol)).toEqual(order);
  });

  it('moves the lifted card up when the pointer is closest to an earlier card', () => {
    // Hover above card a's center (25) -> b should move before a.
    expect(reorderForPointer(order, placed, 'b', 10, 5, oneCol)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves the lifted card down when the pointer is closest to a later card', () => {
    // Hover below card d's center -> b moves to the end.
    expect(reorderForPointer(order, placed, 'b', 10, 400, oneCol)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('returns the original order when there is nothing else to compare to', () => {
    const solo = packColumns(['a'], { a: 50 }, oneCol).placed;
    expect(reorderForPointer(['a'], solo, 'a', 10, 10, oneCol)).toEqual(['a']);
  });

  it('reorders across columns when the pointer is closest to a card in the other column', () => {
    // Two columns: a(col0,y0) b(col1,y0) c(col0,y58) d(col1,y58), all h50.
    const twoCol = { columnWidth: 100, columnGap: 10, rowGap: 8, columns: 2 };
    const twoColPlaced = packColumns(order, { a: 50, b: 50, c: 50, d: 50 }, twoCol).placed;
    // Lift 'a' (col0) and drag into column 1 below d's center (83) -> a lands
    // after d, the last card in that column.
    expect(reorderForPointer(order, twoColPlaced, 'a', 160, 200, twoCol)).toEqual(['b', 'c', 'd', 'a']);
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
