import { AccessibilityInfo, LayoutAnimation, Platform, UIManager } from 'react-native';

// On the legacy (Paper) Android architecture LayoutAnimation must be explicitly
// enabled. The setter is absent on the new (Fabric) architecture, where layout
// animations work out of the box, so guard the call.
if (
  Platform.OS === 'android' &&
  typeof UIManager.setLayoutAnimationEnabledExperimental === 'function'
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Mirror the webapp's `prefers-reduced-motion` handling: skip animations when
// the OS "Reduce Motion" accessibility setting is on. Cached so the per-toggle
// call stays synchronous.
let reduceMotionEnabled = false;
AccessibilityInfo.isReduceMotionEnabled()
  .then((enabled) => {
    reduceMotionEnabled = enabled;
  })
  .catch(() => {
    /* default to animating */
  });
AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
  reduceMotionEnabled = enabled;
});

/**
 * Synchronously reports the cached OS "Reduce Motion" setting. Lets entrance
 * animations (e.g. FadeInView) decide at mount whether to animate without each
 * one re-querying AccessibilityInfo or reaching into this module's internals.
 */
export function isReduceMotionEnabledSync(): boolean {
  return reduceMotionEnabled;
}

/**
 * Duration (ms) of the subtle list "settle" animation. Shared by the legacy
 * LayoutAnimation reflow below and the Reanimated `LinearTransition` applied to
 * the active checklist rows, so both halves of a toggle settle in lockstep.
 */
export const LIST_REFLOW_DURATION_MS = 150;

/**
 * Queue a subtle, quick animation for the next layout commit so list items
 * settle into place instead of jumping — e.g. when an item is checked off and
 * moves into the completed section, or the completed section is collapsed.
 *
 * Note: legacy LayoutAnimation does not animate row repositioning inside a
 * virtualized list (DraggableFlatList); the active checklist rows pair this with
 * a Reanimated `LinearTransition` to slide into place. This call still drives the
 * completed-section (plain View) reflow and overall container resize.
 *
 * Call this immediately before the `setState` that changes the list layout.
 */
export function animateListReflow(): void {
  if (reduceMotionEnabled) return;
  LayoutAnimation.configureNext(
    LayoutAnimation.create(
      LIST_REFLOW_DURATION_MS,
      LayoutAnimation.Types.easeInEaseOut,
      LayoutAnimation.Properties.opacity,
    ),
  );
}
