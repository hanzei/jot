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
 * Queue a subtle, quick animation for the next layout commit so list items
 * settle into place instead of jumping — e.g. when an item is checked off and
 * moves into the completed section, or the completed section is collapsed.
 *
 * Call this immediately before the `setState` that changes the list layout.
 */
export function animateListReflow(): void {
  if (reduceMotionEnabled) return;
  LayoutAnimation.configureNext(
    LayoutAnimation.create(
      150,
      LayoutAnimation.Types.easeInEaseOut,
      LayoutAnimation.Properties.opacity,
    ),
  );
}
