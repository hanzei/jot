import { describe, it, expect } from 'vitest';
import { Lexer } from 'marked';
import { BLOCK_LEXER_OPTIONS, normalizeBlockTokens, type BlockNode } from '../blockMarkdown';
import type { InlineNode } from '../inlineMarkdown';
import { normalizeTaskSource, taskMarkerOffsets, toggleTaskMarkerAt } from '../taskMarkers';

function offsets(content: string): (number | null)[] {
  return taskMarkerOffsets(content, Lexer.lex(content, BLOCK_LEXER_OPTIONS));
}

/** What each offset points at: the `[?]` around it, or null. */
function markers(content: string): (string | null)[] {
  return offsets(content).map((offset) => (offset === null ? null : content.slice(offset - 1, offset + 2)));
}

/** Toggles the `index`th checkbox, the way the webapp does. */
function toggle(content: string, index: number): string {
  const offset = offsets(content)[index];
  if (offset === undefined || offset === null) throw new Error(`no offset for ${index}`);
  return toggleTaskMarkerAt(content, offset);
}

/** Checkbox states in the order the renderer numbers them. */
function renderedTasks(content: string): boolean[] {
  const out: boolean[] = [];
  const inline = (nodes: InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        if (node.task) out.push(node.task.checked);
      } else if ('children' in node) {
        inline(node.children);
      }
    }
  };
  const blocks = (nodes: BlockNode[]) => {
    for (const node of nodes) {
      if (node.type === 'paragraph' || node.type === 'heading') inline(node.children);
      else if (node.type === 'blockquote') blocks(node.children);
      else if (node.type === 'list') node.items.forEach(blocks);
    }
  };
  blocks(normalizeBlockTokens(Lexer.lex(content, BLOCK_LEXER_OPTIONS)));
  return out;
}

describe('taskMarkerOffsets', () => {
  it('finds each marker of a tight list', () => {
    expect(markers('- [ ] a\n- [x] b\n* [X] c')).toEqual(['[ ]', '[x]', '[X]']);
  });

  it('numbers markers in the same order as the rendered checkboxes', () => {
    const content = '- [ ] a\n  - [x] nested\n\n> - [x] quoted\n\n1. [ ] one\n2) [x] two\n\n- [ ] loose\n\n- [x] loose2\n';
    const states = renderedTasks(content);
    expect(states).toEqual([false, true, true, false, true, false, true]);
    expect(markers(content).map((m) => m === '[x]')).toEqual(states);
  });

  it('handles blockquoted and nested-in-quote task lists', () => {
    expect(markers('> - [ ] a\n> > * [x] b')).toEqual(['[ ]', '[x]']);
  });

  it('handles an item that opens with another list marker', () => {
    expect(markers('- - [ ] inner')).toEqual(['[ ]']);
  });

  it('skips task syntax inside a top-level code block', () => {
    const content = '```\n- [ ] not a task\n```\n- [ ] real';
    expect(markers(content)).toEqual(['[ ]']);
    expect(toggle(content, 0)).toBe('```\n- [ ] not a task\n```\n- [x] real');
  });

  it('leaves a block inert when a code block inside an item looks like a task', () => {
    const content = '- [ ] real\n  ```\n  - [ ] fake\n  ```\n\n- [x] other list?';
    // The first list's counts disagree, so none of its boxes get offsets.
    expect(offsets(content).every((offset) => offset === null)).toBe(true);
    expect(renderedTasks(content).length).toBe(offsets(content).length);
  });

  it('leaves a list inert when an empty box is not a task', () => {
    expect(offsets('- [ ]\n- [ ] x')).toEqual([null]);
  });

  it('keeps later blocks mapped after an inert one', () => {
    const content = '- [ ]\n- [ ] x\n\n# Heading\n\n- [x] later';
    expect(markers(content)).toEqual([null, '[x]']);
  });

  it('returns nothing for content without tasks', () => {
    expect(offsets('just text\n\n- item')).toEqual([]);
  });
});

describe('toggleTaskMarkerAt', () => {
  it('checks and unchecks', () => {
    expect(toggle('- [ ] a\n- [x] b', 0)).toBe('- [x] a\n- [x] b');
    expect(toggle('- [ ] a\n- [x] b', 1)).toBe('- [ ] a\n- [ ] b');
    expect(toggle('- [X] a', 0)).toBe('- [ ] a');
  });

  it('only changes the targeted marker when the same line repeats', () => {
    expect(toggle('- [ ] same\n- [ ] same', 1)).toBe('- [ ] same\n- [x] same');
  });

  it('ignores an offset that is not a marker', () => {
    expect(toggleTaskMarkerAt('- [ ] a', 0)).toBe('- [ ] a');
    expect(toggleTaskMarkerAt('- [ ] a', 99)).toBe('- [ ] a');
  });
});

describe('normalizeTaskSource', () => {
  it('maps CRLF content once normalized', () => {
    const content = normalizeTaskSource('- [ ] a\r\n- [x] b\r\n');
    expect(content).toBe('- [ ] a\n- [x] b\n');
    expect(markers(content)).toEqual(['[ ]', '[x]']);
  });
});
