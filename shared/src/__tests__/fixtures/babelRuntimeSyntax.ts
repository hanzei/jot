// Syntax that babel-preset-expo lowers to `@babel/runtime/helpers/*` requires
// (slicedToArray, objectWithoutProperties, asyncToGenerator, createClass,
// classCallCheck). Mobile's Jest compiles shared/src with that preset, and
// mobile/__tests__/sharedBabelRuntime.test.ts imports this file to prove those
// helpers resolve from a file under shared/. Not a vitest suite: it has no
// `.test.ts` suffix.

export function firstOfPairs(pairs: [string, number][]): string[] {
  return pairs.map(([key]) => key);
}

export function splitId(record: { id: string; name: string }): { id: string; rest: { name: string } } {
  const { id, ...rest } = record;
  return { id, rest };
}

export async function doubleLater(value: number): Promise<number> {
  const resolved = await Promise.resolve(value);
  return resolved * 2;
}

export class Counter {
  count = 0;

  increment(): number {
    this.count += 1;
    return this.count;
  }
}
