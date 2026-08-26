import type { ThemeColors } from '../theme/colors';

// Text metrics and colours for the two text-note Markdown surfaces: the editor
// preview (`full`) and the note card (`compact`). The structural styles —
// spacing, the blockquote bar, list indentation — belong to the renderers that
// own that layout (Markdown.tsx, MarkdownPreview.tsx).
//
// h4-h6 deliberately get no size of their own: below h3 the steps are
// indistinguishable at note sizes, so they render as bold body text. The webapp
// matches, via .markdown-content in index.css. See
// docs/specs/markdown-rendering.md.

/**
 * The colours a Markdown surface needs beyond its text colour.
 *
 * `rule` and `tint` are translucent rather than palette entries because the same
 * note body renders on three different backgrounds — the editor, a white card
 * and a coloured card — and an opaque grey that reads correctly on one of them
 * disappears on another. The webapp solves it the same way (`bg-black/5
 * dark:bg-white/10` in .markdown-content).
 */
export interface MarkdownTheme {
  text: string;
  /** Blockquote text. */
  muted: string;
  /** Horizontal rules and the blockquote bar. */
  rule: string;
  /** Code-block background. */
  tint: string;
  link: string;
}

/**
 * Derives the Markdown colours for a note.
 *
 * `onColoredNote` is not the same question as the theme: a coloured note keeps
 * its light swatch in dark mode, so its body is dark-on-light regardless.
 */
export function markdownTheme(
  colors: ThemeColors,
  isDark: boolean,
  onColoredNote: boolean,
): MarkdownTheme {
  if (onColoredNote) {
    return {
      text: '#1a1a1a',
      muted: '#555',
      rule: 'rgba(0,0,0,0.2)',
      tint: 'rgba(0,0,0,0.05)',
      link: colors.primary,
    };
  }

  return {
    text: colors.text,
    muted: colors.textSecondary,
    rule: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)',
    tint: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
    link: colors.primary,
  };
}

export interface MarkdownTextStyles {
  body: { fontSize: number; lineHeight: number };
  heading1: { fontSize: number; fontWeight: '700'; lineHeight: number };
  heading2: { fontSize: number; fontWeight: '700' | '600'; lineHeight: number };
  heading3: { fontSize: number; fontWeight: '700' | '600'; lineHeight: number };
  heading4: { fontSize: number; fontWeight: '700'; lineHeight: number };
  heading5: { fontSize: number; fontWeight: '700'; lineHeight: number };
  heading6: { fontSize: number; fontWeight: '700'; lineHeight: number };
}

/** The editor preview, where a note is read at full size. */
export const fullMarkdownStyles: MarkdownTextStyles = {
  body: { fontSize: 14, lineHeight: 22 },
  heading1: { fontSize: 22, fontWeight: '700', lineHeight: 30 },
  heading2: { fontSize: 18, fontWeight: '600', lineHeight: 26 },
  heading3: { fontSize: 16, fontWeight: '600', lineHeight: 24 },
  heading4: { fontSize: 14, fontWeight: '700', lineHeight: 22 },
  heading5: { fontSize: 14, fontWeight: '700', lineHeight: 22 },
  heading6: { fontSize: 14, fontWeight: '700', lineHeight: 22 },
};

/**
 * The note card, where the whole body is a few clamped lines.
 *
 * Body metrics match the plain-text preview these replaced, so a card holding a
 * note with no formatting is the same height it was. Headings step down to
 * nearly body size for the same reason — a card is too small for h1 to earn 22px,
 * and the clamp is counted in lines.
 */
export const compactMarkdownStyles: MarkdownTextStyles = {
  body: { fontSize: 13, lineHeight: 18 },
  heading1: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  heading2: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  heading3: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  heading4: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  heading5: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  heading6: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
};

/** The heading style for a depth, which is why h4-h6 need no special case. */
export function headingStyle(styles: MarkdownTextStyles, depth: number) {
  switch (depth) {
    case 1:
      return styles.heading1;
    case 2:
      return styles.heading2;
    case 3:
      return styles.heading3;
    case 4:
      return styles.heading4;
    case 5:
      return styles.heading5;
    default:
      return styles.heading6;
  }
}
