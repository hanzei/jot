import { memo, useMemo } from 'react';
import { renderInlineMarkdown } from '@/utils/markdown';

interface InlineMarkdownProps {
  /** Raw list-item text. Rendered as the inline Markdown subset. */
  text: string;
  className?: string;
}

/**
 * Renders list-item text as inline Markdown.
 *
 * Replaces LinkText for item text: bare-URL autolinking is now one case of the
 * inline subset rather than the only formatting an item gets. That left the
 * webapp's LinkText with no callers, so it is gone; mobile keeps its own copy
 * for the server-setup screen, which really does want URLs-only.
 */
function InlineMarkdown({ text, className }: InlineMarkdownProps) {
  const html = useMemo(() => renderInlineMarkdown(text), [text]);

  return (
    <span
      className={`markdown-inline ${className ?? ''}`}
      // A note card is itself clickable, so a click that lands on a link has to
      // stop there or it opens the note as well as following the link. LinkText
      // did this per anchor; innerHTML has no anchors to attach to, so the check
      // moves to the container. Keyboard activation of the link bubbles no click
      // through the card, so there is no matching key handler to add.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) e.stopPropagation();
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default memo(InlineMarkdown);
