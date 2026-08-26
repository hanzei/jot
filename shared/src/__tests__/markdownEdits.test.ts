import { describe, expect, it } from 'vitest';
import {
  clampSelection,
  continueListOnNewline,
  cycleHeading,
  selectedLines,
  toggleBullet,
  toggleCheckbox,
  toggleInlineMarker,
  type EditorText,
} from '../markdownEdits';

/**
 * Builds an editor state from a string with the caret marked by `|`, or a
 * selection marked by a `[...]` pair — keeps the expectations readable.
 */
function at(marked: string): EditorText {
  if (marked.includes('|')) {
    const start = marked.indexOf('|');
    return { text: marked.replace('|', ''), selection: { start, end: start } };
  }
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  return { text: marked.replace('[', '').replace(']', ''), selection: { start, end } };
}

/** Inverse of `at`, so a result can be asserted in the same notation. */
function show(state: EditorText): string {
  const { text, selection } = state;
  if (selection.start === selection.end) {
    return text.slice(0, selection.start) + '|' + text.slice(selection.start);
  }
  return (
    text.slice(0, selection.start) +
    '[' + text.slice(selection.start, selection.end) + ']' +
    text.slice(selection.end)
  );
}

const bold = (state: EditorText) => toggleInlineMarker(state, '**');
const italic = (state: EditorText) => toggleInlineMarker(state, '*');
const strike = (state: EditorText) => toggleInlineMarker(state, '~~');

describe('markdownEdits / toggleInlineMarker', () => {
  it('wraps the selection and keeps it over the same text', () => {
    expect(show(bold(at('make [this] bold')))).toBe('make **[this]** bold');
  });

  it('wraps at the caret and parks the caret between the markers', () => {
    expect(show(bold(at('start |end')))).toBe('start **|**end');
    expect(show(italic(at('|')))).toBe('*|*');
  });

  it('inserts at the caret rather than at the end of the note', () => {
    const state = bold(at('first|\nsecond\nthird'));
    expect(state.text).toBe('first****\nsecond\nthird');
  });

  it('unwraps when the markers surround the selection', () => {
    expect(show(bold(at('a **[bold]** b')))).toBe('a [bold] b');
  });

  it('unwraps when the markers are inside the selection', () => {
    expect(show(bold(at('a [**bold**] b')))).toBe('a [bold] b');
  });

  it('removes an empty pair the caret is parked in', () => {
    expect(show(bold(at('a **|** b')))).toBe('a | b');
  });

  it('does not let an italic toggle eat half of a bold marker', () => {
    expect(show(italic(at('a **[bold]** b')))).toBe('a ***[bold]*** b');
    expect(show(italic(at('a [**bold**] b')))).toBe('a *[**bold**]* b');
  });

  it('round-trips a wrap and an unwrap', () => {
    const once = bold(at('[word]'));
    expect(once.text).toBe('**word**');
    expect(bold(once).text).toBe('word');
  });

  it('wraps and unwraps strikethrough', () => {
    expect(show(strike(at('cross [this] out')))).toBe('cross ~~[this]~~ out');
    expect(show(strike(at('cross ~~[this]~~ out')))).toBe('cross [this] out');
    expect(show(strike(at('done|')))).toBe('done~~|~~');
  });

  it('nests strikethrough and bold without disturbing each other', () => {
    const struck = strike(at('[word]'));
    expect(struck.text).toBe('~~word~~');
    // The inner selection is still just "word", so bold wraps inside.
    expect(bold(struck).text).toBe('~~**word**~~');
  });

  it('handles a reversed selection', () => {
    const reversed: EditorText = { text: 'a word b', selection: { start: 6, end: 2 } };
    expect(bold(reversed).text).toBe('a **word** b');
  });
});

describe('markdownEdits / cycleHeading', () => {
  it('cycles none -> h2 -> h3 -> none on the caret line', () => {
    const plain = at('one\ntw|o\nthree');
    const h2 = cycleHeading(plain);
    expect(h2.text).toBe('one\n## two\nthree');
    const h3 = cycleHeading(h2);
    expect(h3.text).toBe('one\n### two\nthree');
    expect(cycleHeading(h3).text).toBe('one\ntwo\nthree');
  });

  it('acts on the caret line, not the last line of the note', () => {
    expect(cycleHeading(at('ti|tle\nbody')).text).toBe('## title\nbody');
  });

  it('folds an existing h1 into the cycle', () => {
    expect(cycleHeading(at('# ti|tle')).text).toBe('## title');
  });

  it('keeps the caret over the same character', () => {
    expect(show(cycleHeading(at('ti|tle')))).toBe('## ti|tle');
  });

  it('preserves indentation', () => {
    expect(cycleHeading(at('  ti|tle')).text).toBe('  ## title');
  });

  it('applies to every line of a multi-line selection', () => {
    expect(cycleHeading(at('[one\ntwo]')).text).toBe('## one\n## two');
  });
});

describe('markdownEdits / toggleBullet', () => {
  it('bullets the caret line', () => {
    expect(show(toggleBullet(at('one\ntw|o')))).toBe('one\n- tw|o');
  });

  it('removes an existing bullet', () => {
    expect(toggleBullet(at('- it|em')).text).toBe('item');
  });

  it('steps a checklist item down to a plain bullet', () => {
    expect(toggleBullet(at('- [ ] it|em')).text).toBe('- item');
    expect(toggleBullet(at('- [x] it|em')).text).toBe('- item');
  });

  it('bullets an empty line', () => {
    expect(show(toggleBullet(at('|')))).toBe('- |');
  });

  it('adds to every line when the selection is mixed', () => {
    expect(toggleBullet(at('[- one\ntwo]')).text).toBe('- one\n- two');
  });

  it('removes from every line when the whole selection is bulleted', () => {
    expect(toggleBullet(at('[- one\n- two]')).text).toBe('one\ntwo');
  });

  it('leaves blank lines alone inside a multi-line selection', () => {
    expect(toggleBullet(at('[one\n\ntwo]')).text).toBe('- one\n\n- two');
  });

  it('preserves indentation', () => {
    expect(toggleBullet(at('  it|em')).text).toBe('  - item');
  });
});

describe('markdownEdits / toggleCheckbox', () => {
  it('turns a plain line into a checklist item', () => {
    expect(show(toggleCheckbox(at('mi|lk')))).toBe('- [ ] mi|lk');
  });

  it('upgrades an existing bullet in place', () => {
    expect(toggleCheckbox(at('- mi|lk')).text).toBe('- [ ] milk');
  });

  it('removes the whole marker from a checklist item', () => {
    expect(toggleCheckbox(at('- [ ] mi|lk')).text).toBe('milk');
    expect(toggleCheckbox(at('- [x] mi|lk')).text).toBe('milk');
  });

  it('keeps a checked item checked when the selection is mixed', () => {
    // Written out rather than using at(), whose brackets clash with "[x]".
    const state = { text: '- [x] one\ntwo', selection: { start: 0, end: 13 } };
    expect(toggleCheckbox(state).text).toBe('- [x] one\n- [ ] two');
  });
});

describe('markdownEdits / continueListOnNewline', () => {
  /** Enter pressed at the caret marked by `|`. */
  const enterAt = (marked: string) => {
    const previous = at(marked);
    const { start } = previous.selection;
    const typed = previous.text.slice(0, start) + '\n' + previous.text.slice(start);
    return continueListOnNewline(previous, typed);
  };

  it('carries a bullet to the next line', () => {
    const state = enterAt('- one|');
    expect(state && show(state)).toBe('- one\n- |');
  });

  it('carries a checklist marker unchecked', () => {
    expect(enterAt('- [x] one|')?.text).toBe('- [x] one\n- [ ] ');
  });

  it('preserves indentation', () => {
    expect(enterAt('  - one|')?.text).toBe('  - one\n  - ');
  });

  it('clears the marker on an empty item instead of continuing', () => {
    const state = enterAt('- one\n- |');
    expect(state && show(state)).toBe('- one\n|');
  });

  it('continues when the list item is followed by more lines', () => {
    // The diff alone is ambiguous here — the same string results from Enter at
    // the start of "tail" — so this leans on the reported caret.
    expect(enterAt('- one|\ntail')?.text).toBe('- one\n- \ntail');
  });

  it('does not continue when Enter is pressed at the start of a plain line', () => {
    expect(enterAt('- one\n|tail')).toBeNull();
  });

  it('falls back to the diff when the reported caret is stale', () => {
    const stale = { text: '- one', selection: { start: 0, end: 0 } };
    expect(continueListOnNewline(stale, '- one\n')?.text).toBe('- one\n- ');
  });

  it('continues when Enter replaces a selection', () => {
    const state = { text: '- one two', selection: { start: 5, end: 9 } };
    expect(continueListOnNewline(state, '- one\n')?.text).toBe('- one\n- ');
  });

  it('returns null on a non-list line', () => {
    expect(enterAt('plain|')).toBeNull();
  });

  it('returns null for ordinary typing', () => {
    expect(continueListOnNewline(at('- one|'), '- ones')).toBeNull();
    expect(continueListOnNewline(at('- one|'), '- on')).toBeNull();
  });

  it('returns null for a pasted block containing a newline', () => {
    expect(continueListOnNewline(at('- one|'), '- one\nmore text')).toBeNull();
  });
});

describe('markdownEdits / helpers', () => {
  it('lists every line the selection touches', () => {
    expect(selectedLines(at('[one\ntwo]\nthree'))).toEqual(['one', 'two']);
  });

  it('does not reach into the next line when the selection ends at its start', () => {
    expect(selectedLines({ text: 'one\ntwo', selection: { start: 0, end: 4 } })).toEqual(['one']);
  });

  it('clamps a selection to the bounds of the text', () => {
    expect(clampSelection({ start: -3, end: 99 }, 'abc')).toEqual({ start: 0, end: 3 });
    expect(clampSelection({ start: 3, end: 1 }, 'abc')).toEqual({ start: 1, end: 3 });
  });
});
