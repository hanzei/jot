// Mobile's Babel lowers this syntax to `@babel/runtime` helpers. In a file
// under shared/ they resolve only through the `@babel/runtime` mapping in
// jest.config.js; without it, every suite importing @jot/shared fails to load.
import {
  Counter,
  doubleLater,
  firstOfPairs,
  splitId,
} from '../../shared/src/__tests__/fixtures/babelRuntimeSyntax';

describe('shared/src syntax that needs @babel/runtime helpers', () => {
  it('handles array destructuring', () => {
    expect(firstOfPairs([['a', 1], ['b', 2]])).toEqual(['a', 'b']);
  });

  it('handles object rest', () => {
    expect(splitId({ id: 'x', name: 'n' })).toEqual({ id: 'x', rest: { name: 'n' } });
  });

  it('handles async functions', async () => {
    await expect(doubleLater(21)).resolves.toBe(42);
  });

  it('handles classes', () => {
    const counter = new Counter();
    counter.increment();
    expect(counter.increment()).toBe(2);
  });
});
