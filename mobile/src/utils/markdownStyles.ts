// Styles for react-native-markdown-display. The library defaults are too large
// for mobile note cards (H1=32px, H2=24px), so we override heading sizes.
//
// h4-h6 deliberately get no size of their own: below h3 the steps are
// indistinguishable at note sizes, so they render as bold body text. The webapp
// matches, via .markdown-content in index.css. See
// docs/specs/markdown-rendering.md.

export function compactMarkdownStyles(color: string) {
  return {
    body: { color, fontSize: 14, lineHeight: 20 },
    heading1: { fontSize: 15, fontWeight: '700' as const, lineHeight: 20 },
    heading2: { fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },
    heading3: { fontSize: 14, fontWeight: '600' as const, lineHeight: 20 },
    heading4: { fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },
    heading5: { fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },
    heading6: { fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },
  };
}

export function fullMarkdownStyles(color: string) {
  return {
    body: { color, fontSize: 14, lineHeight: 22 },
    heading1: { fontSize: 22, fontWeight: '700' as const, lineHeight: 30 },
    heading2: { fontSize: 18, fontWeight: '600' as const, lineHeight: 26 },
    heading3: { fontSize: 16, fontWeight: '600' as const, lineHeight: 24 },
    heading4: { fontSize: 14, fontWeight: '700' as const, lineHeight: 22 },
    heading5: { fontSize: 14, fontWeight: '700' as const, lineHeight: 22 },
    heading6: { fontSize: 14, fontWeight: '700' as const, lineHeight: 22 },
    // The library default is a solid black bar, invisible on a dark background.
    hr: { backgroundColor: color, opacity: 0.3, height: 1 },
  };
}

export function stripMarkdownForPreview(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '')          // fenced code blocks
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2')      // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')         // italic
    .replace(/~~(.*?)~~/g, '$1')             // strikethrough
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')    // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links, keep label
    .replace(/^>\s*/gm, '')                  // blockquotes
    .replace(/^[\s]*[-*+]\s+\[(x|X| )\]\s*/gm, '') // task list items (bullet + checkbox)
    .replace(/^[\s]*[-*+]\s+/gm, '')         // remaining unordered list markers
    .replace(/^[\s]*\d+\.\s+/gm, '')         // ordered list markers
    .replace(/^[-*_]{3,}\s*$/gm, '')         // horizontal rules
    .replace(/[\r\n]+/g, ' ')                 // collapse newlines to spaces
    .trim();
}
