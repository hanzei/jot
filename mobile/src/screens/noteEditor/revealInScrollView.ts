/**
 * Keeping a focused input visible inside the editor's scroll view.
 *
 * React Native's `scrollResponderScrollNativeHandleToKeyboard` assumes the
 * scroll view runs from the top of the screen down to the keyboard. The editor
 * breaks both assumptions — the header and banners sit above it, and the
 * formatting and action bars sit between it and the keyboard — so it scrolled a
 * focused row too far back up, leaving it hidden under those bars. Measuring the
 * scroll view and the input in the same (window) coordinates instead needs no
 * knowledge of what surrounds the scroll view or where the keyboard is: once the
 * keyboard and bars are laid out, the scroll view's own frame is the visible
 * area.
 */

interface Measurable {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}

interface ScrollableMeasurable extends Measurable {
  scrollTo: (options: { y: number; animated?: boolean }) => void;
}

export interface RevealGeometry {
  /** The scroll view's current content offset. */
  scrollOffset: number;
  /** The scroll view's top edge, in window coordinates. */
  viewportTop: number;
  viewportHeight: number;
  /** The target's top edge, in window coordinates. */
  targetTop: number;
  targetHeight: number;
  /** Breathing room kept between the target and the viewport's edges. */
  margin: number;
}

/**
 * The content offset that brings the target fully into view with the least
 * movement, or null when it is already visible (or nothing was measured).
 */
export function scrollOffsetToReveal({
  scrollOffset,
  viewportTop,
  viewportHeight,
  targetTop,
  targetHeight,
  margin,
}: RevealGeometry): number | null {
  // A view that has not been laid out yet measures as zero; scrolling on that
  // would only jump the list.
  if (viewportHeight <= 0 || targetHeight <= 0) return null;

  // Shrink the margin when the viewport is too short to fit it on both sides.
  const inset = Math.min(margin, Math.max(0, (viewportHeight - targetHeight) / 2));
  const visibleTop = viewportTop + inset;
  const visibleBottom = viewportTop + viewportHeight - inset;
  const targetBottom = targetTop + targetHeight;

  let delta = 0;
  if (targetTop < visibleTop || targetHeight > visibleBottom - visibleTop) {
    // Above the viewport — or taller than it, where its top (the start of the
    // text) is what matters.
    delta = targetTop - visibleTop;
  } else if (targetBottom > visibleBottom) {
    delta = targetBottom - visibleBottom;
  }
  if (Math.abs(delta) < 1) return null;
  return Math.max(0, scrollOffset + delta);
}

function isMeasurable(value: unknown): value is Measurable {
  return typeof (value as Partial<Measurable> | null)?.measureInWindow === 'function';
}

/**
 * Scrolls `scrollView` just far enough to show `target`. Silently does nothing
 * when either side cannot be measured (unmounted, or a test renderer).
 */
export function revealInScrollView(
  scrollView: unknown,
  target: unknown,
  scrollOffset: () => number,
  margin: number,
): void {
  if (!isMeasurable(scrollView) || !isMeasurable(target)) return;
  if (typeof (scrollView as Partial<ScrollableMeasurable>).scrollTo !== 'function') return;
  const scrollable = scrollView as ScrollableMeasurable;
  scrollable.measureInWindow((_vx, viewportTop, _vw, viewportHeight) => {
    target.measureInWindow((_tx, targetTop, _tw, targetHeight) => {
      const y = scrollOffsetToReveal({
        scrollOffset: scrollOffset(),
        viewportTop,
        viewportHeight,
        targetTop,
        targetHeight,
        margin,
      });
      if (y !== null) scrollable.scrollTo({ y, animated: true });
    });
  });
}
