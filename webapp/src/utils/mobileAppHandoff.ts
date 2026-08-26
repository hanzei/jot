// State behind the "open this link in the Jot app" handoff.
//
// A self-hosted instance cannot use Universal Links or verified App Links: iOS
// requires every domain in the app's `associated-domains` entitlement at build
// time, and one published build cannot enumerate the domains its users happen
// to host Jot on. So an `https://<instance>/notes/<id>` link always lands in
// the browser first, and the webapp is what forwards it to `jot://` (see
// `deepLink.ts` for the URL shape).
//
// Why the handoff is learned rather than always attempted: navigating to an
// unhandled custom scheme raises a browser error on iOS Safari ("the address
// is invalid"), so auto-forwarding every visitor would break the common case
// of someone who does not have the app. Instead the first arrival gets a
// prompt, and only a handoff that demonstrably worked — the browser lost
// visibility, meaning another app took the URL — records that the app is
// installed and makes subsequent arrivals automatic.

export const MOBILE_APP_INSTALLED_KEY = 'jot_mobile_app_installed';
export const MOBILE_APP_HANDOFF_DISMISSED_KEY = 'jot_mobile_app_handoff_dismissed';

// How long to wait for the OS to background the browser before concluding that
// nothing claimed the `jot://` URL. Long enough for a cold app launch on a slow
// device, short enough that the fallback does not read as a hang.
export const HANDOFF_TIMEOUT_MS = 1500;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // Private-mode or blocked storage: fall back to the un-learned state, which
    // is the prompt rather than an auto-attempt.
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(key, '1');
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore persistence failures and keep the current session behavior.
  }
}

/** Whether a previous handoff from this browser reached the app. */
export function isMobileAppKnownInstalled(): boolean {
  return readFlag(MOBILE_APP_INSTALLED_KEY);
}

export function setMobileAppKnownInstalled(installed: boolean): void {
  writeFlag(MOBILE_APP_INSTALLED_KEY, installed);
}

/** Whether the visitor chose to stay in the browser in this browser profile. */
export function isMobileAppHandoffDismissed(): boolean {
  return readFlag(MOBILE_APP_HANDOFF_DISMISSED_KEY);
}

/**
 * Turn the arrival handoff off, or back on.
 *
 * Reversible on purpose. "Continue in browser" is one tap on a prompt someone
 * did not ask for, and without a way back it would be a one-way door out of the
 * feature — the settings toggle in `MobileAppPreference` is that way back.
 */
export function setMobileAppHandoffDismissed(dismissed: boolean): void {
  writeFlag(MOBILE_APP_HANDOFF_DISMISSED_KEY, dismissed);
}

export function dismissMobileAppHandoff(): void {
  setMobileAppHandoffDismissed(true);
}

/**
 * Whether this device is plausibly one where the Jot app could be installed.
 *
 * Coarse pointer rather than a user-agent sniff, matching the existing deep
 * link affordances in `NoteModal`. A touchscreen laptop is a false positive,
 * but it only ever sees the prompt — one dismissal and it never returns, and
 * the auto-attempt path is gated on a handoff that actually succeeded.
 */
export function isHandoffCapableDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}
