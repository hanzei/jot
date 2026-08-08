import { useEffect, useId, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buildMobileDeepLink, mapWebPathToMobilePath } from '@/utils/deepLink';
import {
  HANDOFF_TIMEOUT_MS,
  dismissMobileAppHandoff,
  isHandoffCapableDevice,
  isMobileAppHandoffDismissed,
  isMobileAppKnownInstalled,
  setMobileAppKnownInstalled,
} from '@/utils/mobileAppHandoff';

type HandoffPhase = 'idle' | 'prompt' | 'attempting';

interface HandoffStart {
  deepLink: string | null;
  phase: HandoffPhase;
}

/**
 * Decide, once per page load, whether this arrival is a handoff candidate.
 *
 * Reads `window.location` directly rather than the router. The URL that matters
 * is the one the visitor *arrived* on, and an unauthenticated arrival at
 * `/notes/:id` is rewritten to `/login?redirect=…` before the router settles —
 * by which point `useLocation` no longer describes the shared link. Reading the
 * entry URL also means a handoff only ever triggers on arrival: navigating to a
 * note from inside the running webapp does not yank the visitor out of it.
 */
function resolveHandoffStart(): HandoffStart {
  const idle: HandoffStart = { deepLink: null, phase: 'idle' };

  if (!isHandoffCapableDevice() || isMobileAppHandoffDismissed()) {
    return idle;
  }

  // Notes only, even though the app also has a screen for /settings. A note URL
  // is the one people actually send each other; a settings URL is somewhere you
  // navigate yourself, and taking over that arrival would interrupt a visitor
  // who chose the browser rather than help one who was handed a link.
  if (!mapWebPathToMobilePath(window.location.pathname).startsWith('notes/')) {
    return idle;
  }

  const deepLink = buildMobileDeepLink(window.location.pathname, window.location.origin);
  if (!deepLink) {
    return idle;
  }

  return { deepLink, phase: isMobileAppKnownInstalled() ? 'attempting' : 'prompt' };
}

/**
 * Forwards an arrival at a deep-linkable URL to the Jot mobile app.
 *
 * See `utils/mobileAppHandoff.ts` for why a self-hosted instance has to do this
 * from the browser, and why the automatic path is learned rather than assumed.
 */
const MobileAppHandoff = () => {
  const { t } = useTranslation();
  const [start] = useState(resolveHandoffStart);
  const [phase, setPhase] = useState<HandoffPhase>(start.phase);
  const [attemptFailed, setAttemptFailed] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const openButtonRef = useRef<HTMLButtonElement>(null);

  const deepLink = start.deepLink;

  // Take focus when the prompt appears. This overlay deliberately sits outside
  // the app's modal stack (see the render below), so nothing else moves focus
  // onto it.
  useEffect(() => {
    if (phase === 'prompt') {
      openButtonRef.current?.focus();
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== 'attempting' || !deepLink) {
      return;
    }

    // The attempt resolves exactly once, from whichever signal arrives first.
    let settled = false;

    const succeed = () => {
      if (settled) return;
      settled = true;
      setMobileAppKnownInstalled(true);
      // Drop the overlay rather than leaving it up: coming back to the browser
      // should show the page, not a stuck spinner.
      setPhase('idle');
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      // Clear the flag too — an app that no longer answers has been uninstalled,
      // and the next arrival should prompt instead of stalling again.
      setMobileAppKnownInstalled(false);
      setAttemptFailed(true);
      setPhase('prompt');
    };

    // Losing visibility means another app took the URL; nothing else about this
    // page would background the browser at this moment.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        succeed();
      }
    };

    const timer = window.setTimeout(() => {
      // Treat a browser that is already backgrounded as a success even when the
      // visibility event never landed.
      if (document.visibilityState === 'visible') {
        fail();
      } else {
        succeed();
      }
    }, HANDOFF_TIMEOUT_MS);

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', succeed);

    window.location.href = deepLink;

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', succeed);
    };
  }, [phase, deepLink]);

  if (phase === 'idle' || !deepLink) {
    return null;
  }

  if (phase === 'attempting') {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="mobile-app-handoff-attempting"
        className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-4 bg-gray-50 dark:bg-slate-900"
      >
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-500 motion-reduce:animate-none" />
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('mobileApp.opening')}</p>
      </div>
    );
  }

  return (
    // Deliberately not a @headlessui Dialog, unlike every other modal here.
    // This overlay is a gate in front of the whole app rather than a step
    // inside it, and it can be on screen while the note modal opens underneath
    // — two Headless UI dialogs then fight over the modal stack, and the one
    // opened last marks the other inert no matter how the z-indexes are set.
    // A plain overlay above the app's layers (Toast is the highest at z-100)
    // sidesteps that; focus is moved by the effect above instead.
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="mobile-app-handoff-prompt"
      // Escape hides the prompt for this arrival only. Persisting "stop asking"
      // is reserved for the explicit button below, so a stray key does not
      // silently turn the handoff off for good.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setPhase('idle');
        }
      }}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4 dark:bg-black/60"
    >
      <div className="mx-auto w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 rounded-full bg-blue-100 p-2 dark:bg-blue-900/30">
            <Smartphone className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-white">
              {t('mobileApp.handoffTitle')}
            </h2>
            <p id={descriptionId} className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              {t('mobileApp.handoffMessage', { server: window.location.host })}
            </p>
            {attemptFailed && (
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-400" data-testid="mobile-app-handoff-failed">
                {t('mobileApp.notInstalled')}
              </p>
            )}
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            ref={openButtonRef}
            data-testid="mobile-app-handoff-open"
            onClick={() => {
              setAttemptFailed(false);
              setPhase('attempting');
            }}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
          >
            {t('mobileApp.openInApp')}
          </button>
          <button
            type="button"
            data-testid="mobile-app-handoff-stay"
            onClick={() => {
              dismissMobileAppHandoff();
              setPhase('idle');
            }}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-slate-600 dark:bg-slate-700 dark:text-gray-300 dark:hover:bg-slate-600 dark:focus:ring-offset-slate-800"
          >
            {t('mobileApp.continueInBrowser')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MobileAppHandoff;
