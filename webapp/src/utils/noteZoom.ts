import { canAnimate } from '@/utils/motion';

/**
 * The note modal's zoom transition: it grows out of the clicked note card and
 * shrinks back onto it on close, mirroring the mobile editor's zoom
 * (mobile/src/screens/NoteEditorScreen.tsx).
 *
 * Unlike mobile, the modal is a centred panel rather than a full-screen view,
 * so the panel is scaled uniformly (matched to the card's width) instead of
 * stretched to the card's exact box — a non-uniform scale visibly squashes the
 * text when a wide card opens into the narrower modal. The panel fades in over
 * the first fifth of the open and out over the last fifth of the close, so the
 * card's shape mismatch is never visible at the card end.
 *
 * Both directions are skipped under reduced motion (see canAnimate), and are
 * plain Web Animations on DOM nodes, outside React state:
 * the open animates the live panel, the close animates a detached snapshot of
 * it (see playNoteModalExit) so the modal can unmount immediately and none of
 * its effects, listeners, or autosave keep running through the animation.
 */

const NOTE_ZOOM_MS = 250;
// Matches the fade/scale the modal used before the zoom, kept for opens that
// have no card to grow from (deep links, new notes, the shared-note toast).
const FALLBACK_MS = 200;

// easeOutCubic / easeInCubic, as on mobile.
const EASE_OUT = 'cubic-bezier(0.33, 1, 0.68, 1)';
const EASE_IN = 'cubic-bezier(0.32, 0, 0.67, 0)';

function isOnScreen(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0
    && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** The transform that maps `from` (the panel's box) onto `to` (a card's box). */
function cardTransform(from: DOMRect, to: DOMRect): string {
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const scale = Math.min(Math.max(to.width / from.width, 0.05), 4);
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

/**
 * The on-screen rect of the note's card right now, or null when it is not
 * rendered or not visible. The modal measures the live card at close time
 * rather than reusing the click-time rect, which goes stale when the grid
 * reflows under the open modal (a pin, a longer note, a re-sort). When more
 * than one card matches, the one closest to `near` (the click-time rect) wins.
 */
export function findNoteCardRect(noteId: string, near: DOMRect): DOMRect | null {
  const cards = document.querySelectorAll(`[data-note-id="${CSS.escape(noteId)}"]`);
  let best: DOMRect | null = null;
  let bestDistance = Infinity;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (!isOnScreen(rect)) continue;
    const distance = (rect.left - near.left) ** 2 + (rect.top - near.top) ** 2;
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return best;
}

/** Marks the close's snapshot and its backdrop (they are not the real modal). */
const NOTE_ZOOM_GHOST_ATTR = 'data-note-zoom-ghost';

/** Where an animated element visually is right now, as a keyframe. */
export type ZoomFrame = { transform: string; opacity: number };

/**
 * Zoom the freshly mounted panel open from `origin` (the clicked card's rect).
 * The caller only has an origin when canAnimate allowed one.
 */
export function playNoteModalOpen(panel: HTMLElement, origin: DOMRect): Animation {
  return panel.animate(
    [
      { transform: cardTransform(panel.getBoundingClientRect(), origin), opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: NOTE_ZOOM_MS, easing: EASE_OUT },
  );
}

/**
 * Stop the open zoom, returning where it had got to if it was still running so
 * the close can start from there rather than from the panel's full size.
 */
export function stopNoteModalOpen(panel: HTMLElement, animation: Animation | null): ZoomFrame | null {
  if (!animation) return null;
  let frame: ZoomFrame | null = null;
  if (animation.playState === 'running') {
    const style = getComputedStyle(panel);
    frame = { transform: style.transform, opacity: Number(style.opacity) };
  }
  animation.cancel();
  return frame;
}

/**
 * Play the modal's close over a snapshot of `panel`, which must still be in the
 * document (call it from the modal's layout-effect cleanup, which React runs
 * before removing the DOM). Shrinks onto `target` when given, otherwise fades
 * and scales down slightly. `from` is where an interrupted open zoom had got to
 * (stopNoteModalOpen); the panel itself must already be back at rest, since its
 * layout box is what the snapshot copies.
 *
 * The snapshot is appended on the next microtask rather than synchronously, so
 * a StrictMode simulated unmount can call the returned cancel function from the
 * effect's re-run before anything reaches the document.
 */
export function playNoteModalExit(panel: HTMLElement, target: DOMRect | null, from: ZoomFrame | null = null): () => void {
  if (!canAnimate(panel) || !panel.isConnected) return () => {};

  const rect = panel.getBoundingClientRect();
  const ghost = panel.cloneNode(true) as HTMLElement;
  // cloneNode copies attributes, not live state: carry over what the user typed
  // and toggled, and (once attached) where each scroll container was scrolled.
  const sourceFields = panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  const ghostFields = ghost.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  sourceFields.forEach((field, i) => {
    const copy = ghostFields[i];
    if (!copy) return;
    copy.value = field.value;
    if (field instanceof HTMLInputElement && copy instanceof HTMLInputElement) copy.checked = field.checked;
  });
  // Only these can be scrolled: the modal's overflow regions and textareas.
  const SCROLLABLE = 'textarea, [class*="overflow-"]';
  const scrolled: Array<[number, number, number]> = [];
  panel.querySelectorAll(SCROLLABLE).forEach((el, i) => {
    if (el.scrollTop || el.scrollLeft) scrolled.push([i, el.scrollTop, el.scrollLeft]);
  });

  // Purely visual: hidden from assistive tech, unreachable, click-through, and
  // stripped of ids and test ids so nothing can mistake it for the real modal.
  for (const el of [ghost, ...ghost.querySelectorAll('[id], [data-testid]')]) {
    el.removeAttribute('id');
    el.removeAttribute('data-testid');
  }
  ghost.removeAttribute('data-note-modal-panel');
  ghost.setAttribute(NOTE_ZOOM_GHOST_ATTR, '');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    zIndex: '50',
    pointerEvents: 'none',
  });

  const backdrop = document.createElement('div');
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.setAttribute(NOTE_ZOOM_GHOST_ATTR, '');
  backdrop.className = 'fixed inset-0 z-50 pointer-events-none bg-black/30 dark:bg-black/50';

  let cancelled = false;
  const animations: Animation[] = [];
  queueMicrotask(() => {
    if (cancelled) return;
    document.body.append(backdrop, ghost);
    const ghostDescendants = ghost.querySelectorAll(SCROLLABLE);
    for (const [i, top, left] of scrolled) {
      const el = ghostDescendants[i];
      if (el) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    }

    const duration = target ? NOTE_ZOOM_MS : FALLBACK_MS;
    const start = from ?? { transform: 'none', opacity: 1 };
    const panelFrames: Keyframe[] = target
      ? [
        start,
        { opacity: start.opacity, offset: 0.8 },
        { transform: cardTransform(rect, target), opacity: 0 },
      ]
      : [
        start,
        { transform: 'scale(0.95)', opacity: 0 },
      ];
    animations.push(
      ghost.animate(panelFrames, { duration, easing: target ? EASE_IN : 'ease-out', fill: 'forwards' }),
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' }),
    );
    void Promise.allSettled(animations.map(a => a.finished)).then(() => {
      ghost.remove();
      backdrop.remove();
    });
  });

  return () => {
    cancelled = true;
    animations.forEach(a => a.cancel());
    ghost.remove();
    backdrop.remove();
  };
}
