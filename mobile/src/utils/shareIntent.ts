import { VALIDATION } from '@jot/shared';

// Minimal shape of the payload delivered by expo-share-intent. Kept local (and
// independent of the library types) so this helper stays pure and unit-testable
// without pulling in the native module.
export interface ShareIntentLike {
  text?: string | null;
  webUrl?: string | null;
}

// extractSharedText turns an incoming Android "send text" intent into the body
// of a new note. Shared plain text arrives in `text`; a shared link may arrive
// in `webUrl` (and is appended when it differs from the text). The result is
// trimmed and capped to the note content limit so the pre-filled editor never
// starts out over the maximum length.
export function extractSharedText(shareIntent: ShareIntentLike | null | undefined): string | null {
  if (!shareIntent) {
    return null;
  }

  const parts: string[] = [];
  const text = shareIntent.text?.trim();
  if (text) {
    parts.push(text);
  }
  const webUrl = shareIntent.webUrl?.trim();
  if (webUrl && webUrl !== text) {
    parts.push(webUrl);
  }

  const combined = parts.join('\n\n').trim();
  if (!combined) {
    return null;
  }

  return combined.slice(0, VALIDATION.CONTENT_MAX_LENGTH);
}
