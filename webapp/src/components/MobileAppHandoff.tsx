import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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

type HandoffPhase = 'idle' | 'prompt' | 'attempting' | 'handedOff';

// The prompt only ever holds buttons today; links are covered so that stays
// true if one is added.
const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href]';

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

interface MobileAppHandoffProps {
  /**
   * The app itself, rendered only once the handoff is out of the way.
   *
   * Gating it is what keeps the prompt from sitting on top of a half-drawn note
   * behind a scrim: until the visitor picks the browser, the note is not opened
   * at all. Withholding beats hiding here — the app under `display: none`
   * measures itself at zero and animates oddly on reveal, whereas mounting it
   * on dismissal is just an ordinary page load.
   */
  children?: ReactNode;
}

/**
 * Forwards an arrival at a deep-linkable URL to the Jot mobile app.
 *
 * See `utils/mobileAppHandoff.ts` for why a self-hosted instance has to do this
 * from the browser, and why the automatic path is learned rather than assumed.
 */
const MobileAppHandoff = ({ children }: MobileAppHandoffProps) => {
  const { t } = useTranslation();
  const [start] = useState(resolveHandoffStart);
  const [phase, setPhase] = useState<HandoffPhase>(start.phase);
  const [attemptFailed, setAttemptFailed] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

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
      // Stop here rather than falling through to 'idle', which would mount the
      // whole webapp and fetch the note into a tab nobody is looking at. The
      // browser cannot close its own tab — window.close() only works on
      // script-opened windows — so a terminal screen is the whole of the
      // cleanup available.
      setPhase('handedOff');
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

  /**
   * Escape closes; Tab cycles within the prompt.
   *
   * The trap is hand-rolled because this overlay is not a Headless UI dialog
   * (see the render below). Without it `aria-modal="true"` would be a lie —
   * assistive tech is told the rest of the page is inert while Tab walks
   * straight out into the note modal behind the scrim.
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Escape hides the prompt for this arrival only. Persisting "stop asking"
    // is reserved for the explicit button below, so a stray key does not
    // silently turn the handoff off for good.
    if (e.key === 'Escape') {
      setPhase('idle');
      return;
    }
    if (e.key !== 'Tab' || !overlayRef.current) {
      return;
    }

    const focusable = overlayRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length === 0) {
      return;
    }
    // Both indexes are in range: length is non-zero, checked directly above.
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    const active = document.activeElement;
    // Focus already outside — a backdrop tap can leave it on <body>, and from
    // there Tab would escape rather than wrap.
    if (!active || !overlayRef.current.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (phase === 'idle' || !deepLink) {
    return <>{children}</>;
  }

  if (phase === 'handedOff') {
    return (
      <div
        data-testid="mobile-app-handoff-done"
        className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-4 bg-gray-50 p-4 text-center dark:bg-slate-900"
      >
        <div className="rounded-full bg-blue-100 p-3 dark:bg-blue-900/30">
          <Smartphone className="h-6 w-6 text-blue-600 dark:text-blue-400" aria-hidden="true" />
        </div>
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">{t('mobileApp.handedOffTitle')}</h1>
        <p className="max-w-xs text-sm text-gray-600 dark:text-gray-300">{t('mobileApp.handedOffMessage')}</p>
        <button
          type="button"
          data-testid="mobile-app-handoff-continue"
          // Deliberately does not persist a dismissal, unlike the same label on
          // the prompt: the handoff just worked, so the visitor is asking to see
          // this one note here, not to turn the feature off. It also covers the
          // rare false positive, where visibility was lost to something other
          // than the Jot app.
          onClick={() => setPhase('idle')}
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-slate-600 dark:bg-slate-700 dark:text-gray-300 dark:hover:bg-slate-600 dark:focus:ring-offset-slate-900"
        >
          {t('mobileApp.continueInBrowser')}
        </button>
      </div>
    );
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
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="mobile-app-handoff-prompt"
      onKeyDown={handleKeyDown}
      // A plain page background rather than a scrim: there is nothing behind it
      // to dim, since the app is not rendered until the handoff is resolved.
      className="fixed inset-0 z-[120] flex items-center justify-center bg-gray-50 p-4 dark:bg-slate-900"
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
              {t('mobileApp.handoffMessage')}
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
