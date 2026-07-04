import { VALIDATION } from '@jot/shared';

export interface SharedContentParams {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

// buildSharedContent turns a Web Share Target payload (title/text/url query
// params) into the body of a prefilled new note. Mirrors the mobile share
// intent's extractSharedText: parts are deduped, joined with blank lines, and
// capped to the note content limit so the editor never opens over the max.
export function buildSharedContent({ title, text, url }: SharedContentParams): string {
  const parts: string[] = [];
  const trimmedTitle = title?.trim();
  if (trimmedTitle) parts.push(trimmedTitle);
  const trimmedText = text?.trim();
  if (trimmedText && trimmedText !== trimmedTitle) parts.push(trimmedText);
  const trimmedUrl = url?.trim();
  if (trimmedUrl && trimmedUrl !== trimmedText && trimmedUrl !== trimmedTitle) parts.push(trimmedUrl);

  const combined = parts.join('\n\n').trim();
  return combined.slice(0, VALIDATION.CONTENT_MAX_LENGTH);
}
