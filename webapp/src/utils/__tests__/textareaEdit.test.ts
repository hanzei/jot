import { describe, expect, it } from 'vitest';
import { changedRange } from '../textareaEdit';

/** Applies a range the way execCommand would, to prove it reconstructs `next`. */
function apply(previous: string, range: ReturnType<typeof changedRange>): string {
  return previous.slice(0, range.start) + range.replacement + previous.slice(range.end);
}

describe('changedRange', () => {
  const cases: { name: string; previous: string; next: string }[] = [
    { name: 'wrapping a word in bold', previous: 'aaa foo bbb', next: 'aaa **foo** bbb' },
    { name: 'unwrapping bold', previous: 'aaa **foo** bbb', next: 'aaa foo bbb' },
    { name: 'adding a bullet', previous: 'foo', next: '- foo' },
    { name: 'removing a bullet (empty replacement)', previous: '- foo', next: 'foo' },
    { name: 'heading cycle none -> ##', previous: 'title', next: '## title' },
    { name: 'heading cycle ### -> none', previous: '### title', next: 'title' },
    { name: 'checkbox on an existing bullet', previous: '- foo', next: '- [ ] foo' },
    { name: 'list continuation onto a new line', previous: '- one\n', next: '- one\n- ' },
    { name: 'multi-line block toggle', previous: 'a\nb\nc', next: '- a\n- b\n- c' },
    { name: 'repeated characters', previous: 'aa', next: 'aaa' },
    { name: 'empty to content', previous: '', next: '**' },
    { name: 'content to empty', previous: '**', next: '' },
    { name: 'no change at all', previous: 'same', next: 'same' },
  ];

  it.each(cases)('reconstructs $name', ({ previous, next }) => {
    expect(apply(previous, changedRange(previous, next))).toBe(next);
  });

  it('touches only the changed span, so undo steps over the markers not the note', () => {
    const previous = 'a very long note with lots of text before foo and lots after';
    const next = previous.replace('foo', '**foo**');
    const range = changedRange(previous, next);

    expect(previous.slice(range.start, range.end)).toBe('foo');
    expect(range.replacement).toBe('**foo**');
  });

  it('never lets the suffix scan run back past the prefix', () => {
    // "aa" -> "aaa": both ends match, and counting them independently would
    // produce an inverted range.
    const range = changedRange('aa', 'aaa');
    expect(range.end).toBeGreaterThanOrEqual(range.start);
    expect(apply('aa', range)).toBe('aaa');
  });

  it('reports an empty replacement for a pure deletion', () => {
    const range = changedRange('- foo', 'foo');
    expect(range.replacement).toBe('');
    expect(range).toMatchObject({ start: 0, end: 2 });
  });
});
