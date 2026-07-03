/**
 * Shared helpers for opt-in UI animations.
 *
 * Animations are skipped when the user prefers reduced motion or when the
 * Web Animations API is unavailable (e.g. jsdom in tests), so callers can run
 * `element.animate(...)` unconditionally behind `canAnimate`.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Returns true when `element` exists, supports the Web Animations API, and the
 * user has not requested reduced motion. Doubles as a type guard so the element
 * is narrowed to `HTMLElement` in the truthy branch.
 */
export function canAnimate(element: Element | null | undefined): element is HTMLElement {
  return (
    !!element &&
    typeof (element as HTMLElement).animate === 'function' &&
    !prefersReducedMotion()
  );
}
