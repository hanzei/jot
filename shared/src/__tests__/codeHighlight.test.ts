import { describe, it, expect } from 'vitest';
import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import {
  CODE_PALETTE,
  CODE_SCOPES,
  HIGHLIGHT_LANGUAGES,
  codeLanguage,
  highlightCode,
  type CodeHighlighter,
  type CodeRun,
  type HighlightLanguage,
} from '../codeHighlight';

// highlight.js is a devDependency here purely so this suite can run the policy
// against the real grammars — codeHighlight.ts itself imports nothing. Each
// client builds the same instance in its own utils/codeHighlighter.ts.

const GRAMMARS: Record<HighlightLanguage, LanguageFn> = {
  bash, css, go, javascript, json, python, sql, typescript, xml, yaml,
};

const highlighter = hljs.newInstance();
for (const name of HIGHLIGHT_LANGUAGES) highlighter.registerLanguage(name, GRAMMARS[name]);

function runs(code: string, language: string): CodeRun[] {
  const result = highlightCode(highlighter, code, language);
  if (!result) throw new Error(`${language} did not highlight`);
  return result;
}

/** The scope a run with exactly this text was drawn in. */
function scopeOf(code: string, language: string, text: string) {
  const run = runs(code, language).find((r) => r.text === text);
  if (!run) throw new Error(`no run reads exactly ${JSON.stringify(text)}`);
  return run.scope;
}

/** One snippet per language, exercising its common token kinds. */
const SAMPLES: Record<HighlightLanguage, string> = {
  bash: '#!/bin/bash\n# list\nfor f in *.txt; do echo "$f" > /dev/null; done',
  css: '@media (min-width: 4px) {\n  .card > #id:hover { color: #fff !important; }\n}',
  go: 'package main\n\n// Add adds.\nfunc Add(a, b int) int { return a + b }',
  javascript: 'const s = `a ${b} c`; // done\nclass A extends B { m() { return this.x ?? null; } }',
  json: '{"a": [1, 2.5, true, null], "b": "x\\"y"}',
  python: '@cache\ndef größe(n: int) -> str:\n    """Doc."""\n    return f"{n!r}"  # é',
  sql: "SELECT id, COUNT(*) FROM notes WHERE title LIKE '%a%' -- c\nGROUP BY id;",
  typescript: 'interface P<T> { a?: T }\nexport async function f(x: unknown): Promise<void> {}',
  xml: '<?xml version="1.0"?>\n<!-- c -->\n<a href="x" data-é="1">&amp; <b>t</b></a>',
  yaml: '# c\nkey: value\nlist:\n  - 1\n  - "two"\nanchor: &a {x: true}',
};

describe('codeLanguage', () => {
  it.each([
    ['js', 'js'],
    ['TypeScript', 'typescript'],
    ['  py  ', 'py'],
    ['js title="a b"', 'js'],
    ['', null],
    [undefined, null],
  ])('normalizes %j to %j', (info, expected) => {
    expect(codeLanguage(info)).toBe(expected);
  });
});

describe('highlightCode', () => {
  it('renders plain when there is no language', () => {
    expect(highlightCode(highlighter, 'const a = 1;', null)).toBeNull();
  });

  it('renders plain for a language Jot does not register', () => {
    expect(highlightCode(highlighter, '+[->+<]>.', 'brainfuck')).toBeNull();
    // A real highlight.js language, just not one Jot ships.
    expect(highlightCode(highlighter, 'fn main() {}', 'rust')).toBeNull();
  });

  it.each(HIGHLIGHT_LANGUAGES)('%s: the runs reassemble the source exactly and scope something', (language) => {
    const result = runs(SAMPLES[language], language);
    expect(result.map((r) => r.text).join('')).toBe(SAMPLES[language]);
    expect(result.some((r) => r.scope !== null)).toBe(true);
  });

  it.each(['js', 'ts', 'py', 'sh', 'html', 'yml', 'JSON', 'Go'])('resolves the alias %s', (alias) => {
    expect(highlightCode(highlighter, 'x', alias)).not.toBeNull();
  });

  it('merges adjacent runs of the same scope', () => {
    const result = runs('a = 1\nb = 2', 'python');
    for (const [index, run] of result.entries()) {
      if (index > 0) expect(run.scope).not.toBe(result[index - 1]!.scope);
    }
  });

  it('maps the common token kinds to scopes', () => {
    const js = 'function greet(n) { const s = "hi"; return this.x + 42; } // done';
    expect(scopeOf(js, 'js', 'function')).toBe('keyword');
    expect(scopeOf(js, 'js', 'greet')).toBe('title');
    expect(scopeOf(js, 'js', '"hi"')).toBe('string');
    expect(scopeOf(js, 'js', '42')).toBe('literal');
    expect(scopeOf(js, 'js', '// done')).toBe('comment');
    // `this` is highlight.js's `variable.language` — a sub-scope that overrides
    // `variable`'s own mapping.
    expect(scopeOf(js, 'js', 'this')).toBe('keyword');

    expect(scopeOf('x: string', 'ts', 'string')).toBe('type');
    expect(scopeOf('<a href="x">', 'html', 'a')).toBe('keyword');
    expect(scopeOf('<a href="x">', 'html', 'href')).toBe('attribute');
    expect(scopeOf('<a href="x">', 'html', '"x"')).toBe('string');
  });

  it('draws template-string interpolation as code, not as string', () => {
    const result = runs('`a ${b} c`', 'js');
    expect(result.find((r) => r.text.includes('b'))?.scope).toBeNull();
    expect(result[0]).toEqual({ text: '`a ', scope: 'string' });
  });

  it('decodes every character highlight.js escapes', () => {
    const code = 'const s = "<&>\'" + \'"\';';
    expect(runs(code, 'js').map((r) => r.text).join('')).toBe(code);
  });

  describe('falls back to plain text', () => {
    const fake = (value: string): CodeHighlighter => ({
      getLanguage: () => ({}),
      highlight: () => ({ value }),
    });

    it('when the highlighter throws', () => {
      const throwing: CodeHighlighter = {
        getLanguage: () => ({}),
        highlight: () => { throw new Error('grammar failed'); },
      };
      expect(highlightCode(throwing, 'x', 'js')).toBeNull();
    });

    it.each([
      ['an unexpected tag', '<b>x</b>'],
      ['a stray closing span', 'x</span>'],
      ['output that loses text', '<span class="hljs-keyword">y</span>'],
    ])('on %s', (_label, value) => {
      expect(highlightCode(fake(value), 'x', 'js')).toBeNull();
    });
  });
});

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('CODE_PALETTE', () => {
  // The panel is what makes this the whole check: a code block's background is
  // always one of these two, whatever the note colour (see CODE_PALETTE).
  it.each(['light', 'dark'] as const)('%s: plain code and every token colour hold 4.5:1 on the panel', (theme) => {
    const { panel, text, scopes } = CODE_PALETTE[theme];
    expect(contrast(text, panel)).toBeGreaterThanOrEqual(4.5);
    for (const scope of CODE_SCOPES) {
      expect({ scope, ratio: contrast(scopes[scope], panel) >= 4.5 }).toEqual({ scope, ratio: true });
    }
  });
});
