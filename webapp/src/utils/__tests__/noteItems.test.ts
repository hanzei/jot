import { describe, it, expect } from 'vitest';
import { indentOf } from '../noteItems';

// The ordering/cascade/drop-target/indent rules themselves are tested once, in
// shared/src/__tests__/listItems.test.ts.
describe('indentOf', () => {
  it('reports 0 for a top-level item and 1 for a nested one', () => {
    expect(indentOf({ parentId: null })).toBe(0);
    expect(indentOf({ parentId: 'a' })).toBe(1);
  });
});
