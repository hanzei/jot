import { memo, useMemo } from 'react';
import { renderInlineMarkdown } from '@/utils/markdown';

interface InlineMarkdownProps {
  /** Raw list-item text. Rendered as the inline Markdown subset. */
  text: string;
  className?: string;
  /**
   * Whether links render as links. Note cards pass `false` — see
   * docs/specs/markdown-rendering.md §1.
   */
  links?: boolean;
}

/**
 * Renders list-item text as inline Markdown.
 *
 * Replaces LinkText for item text: bare-URL autolinking is now one case of the
 * inline subset rather than the only formatting an item gets. That left the
 * webapp's LinkText with no callers, so it is gone; mobile keeps its own copy
 * for the server-setup screen, which really does want URLs-only.
 *
 * No click handling, deliberately. The one surface that renders item text inside
 * a clickable container is the note card, and a card passes `links={false}`, so
 * there is no anchor for a click to land on. The container-level
 * `stopPropagation` this used to carry — whose only job was to stop a link click
 * from opening the note as well — went with them.
 */
function InlineMarkdown({ text, className, links = true }: InlineMarkdownProps) {
  const html = useMemo(() => renderInlineMarkdown(text, { links }), [text, links]);

  return (
    <span
      className={`markdown-inline ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default memo(InlineMarkdown);
