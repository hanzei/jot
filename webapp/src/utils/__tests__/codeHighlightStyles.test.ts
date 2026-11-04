import { describe, it, expect } from 'vitest';
import { CODE_ITALIC_SCOPES, CODE_PALETTE, CODE_SCOPES } from '@jot/shared';
// Read raw: vite.config.ts lists index.css under `test.css.include` for this.
import css from '../../index.css?raw';

// The highlight colours live in index.css as Tailwind utilities, because the
// stylesheet cannot import a TypeScript constant. They are CODE_PALETTE
// (shared/src/codeHighlight.ts), which mobile reads directly and whose contrast
// the shared suite checks — so this pins the copy to the source.

/** The `@apply` list of the one `.markdown-content <selector>` rule. */
function applied(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`\\.markdown-content ${escaped} \\{\\s*@apply ([^;]*);`, 'g'))];
  expect(matches, `exactly one rule for .markdown-content ${selector}`).toHaveLength(1);
  return matches[0]![1]!.split(/\s+/);
}

describe('code highlight styles in index.css', () => {
  it('puts code blocks on the shared panel, text and border colours', () => {
    expect(applied('pre')).toEqual(expect.arrayContaining([
      `bg-[${CODE_PALETTE.light.panel}]`,
      `dark:bg-[${CODE_PALETTE.dark.panel}]`,
      `text-[${CODE_PALETTE.light.text}]`,
      `dark:text-[${CODE_PALETTE.dark.text}]`,
      `border-[${CODE_PALETTE.light.border}]`,
      `dark:border-[${CODE_PALETTE.dark.border}]`,
    ]));
  });

  it.each(CODE_SCOPES)('colours data-code="%s" from the shared palette', (scope) => {
    const classes = applied(`[data-code="${scope}"]`);
    expect(classes).toEqual(expect.arrayContaining([
      `text-[${CODE_PALETTE.light.scopes[scope]}]`,
      `dark:text-[${CODE_PALETTE.dark.scopes[scope]}]`,
    ]));
    expect(classes.includes('italic')).toBe(CODE_ITALIC_SCOPES.has(scope));
  });
});
