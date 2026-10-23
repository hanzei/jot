import { useCallback, useEffect, useRef, useState } from 'react';

const COPIED_RESET_MS = 2000;

// Copies via a hidden textarea and execCommand, for where the Clipboard API is
// unavailable. The textarea is always removed (it may hold a secret such as a
// new PAT) and focus goes back to where it was, so a keyboard user keeps their
// place.
function copyWithExecCommand(text: string): boolean {
  const previous = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

// Copies text to the clipboard, falling back to execCommand where the
// Clipboard API is unavailable (e.g. a self-hosted server on plain HTTP).
// `copied` stays true for a moment after a successful copy, for a "Copied!"
// label.
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = copyWithExecCommand(text);
    }
    if (!ok) return;
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, []);

  return { copied, copy };
}
