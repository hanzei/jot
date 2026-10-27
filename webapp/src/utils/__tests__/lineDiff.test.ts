import { describe, it, expect } from 'vitest';
import { diffLines } from '../lineDiff';

const render = (before: string, after: string) =>
  diffLines(before, after).map(line => `${line.kind === 'same' ? ' ' : line.kind === 'removed' ? '-' : '+'}${line.text}`);

describe('diffLines', () => {
  it('marks nothing when both sides are equal', () => {
    expect(render('a\nb', 'a\nb')).toEqual([' a', ' b']);
  });

  it('shows a changed line as a removal followed by an addition', () => {
    expect(render('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('aligns insertions and deletions on the common lines', () => {
    expect(render('one\ntwo\nthree\nfour', 'one\nthree\nfour\nfive')).toEqual([
      ' one', '-two', ' three', ' four', '+five',
    ]);
  });

  it('treats an empty side as no lines', () => {
    expect(render('', 'a\nb')).toEqual(['+a', '+b']);
    expect(render('a', '')).toEqual(['-a']);
    expect(render('', '')).toEqual([]);
  });

  it('keeps blank lines as lines', () => {
    expect(render('a\n\nb', 'a\nb')).toEqual([' a', '-', ' b']);
  });
});
