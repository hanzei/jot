import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileAppHandoff from '@/components/MobileAppHandoff';
import {
  HANDOFF_TIMEOUT_MS,
  isMobileAppHandoffDismissed,
  isMobileAppKnownInstalled,
  setMobileAppKnownInstalled,
} from '@/utils/mobileAppHandoff';

const ORIGIN = 'https://jot.example.com';
const NOTE_DEEP_LINK = 'jot://notes/note-1?server=https%3A%2F%2Fjot.example.com';

const realLocation = window.location;

/**
 * Replace `window.location` wholesale: the component both reads the entry URL
 * from it and hands off by assigning `href`, and jsdom cannot navigate to a
 * custom scheme. The returned array collects every assignment.
 */
function stubLocation(pathname: string): string[] {
  const assigned: string[] = [];
  const stub = {
    pathname,
    origin: ORIGIN,
    host: 'jot.example.com',
    get href() {
      return `${ORIGIN}${pathname}`;
    },
    set href(value: string) {
      assigned.push(value);
    },
  };
  Object.defineProperty(window, 'location', { value: stub, writable: true, configurable: true });
  return assigned;
}

// Headless UI subscribes to its own media queries, so this has to be a full
// MediaQueryList rather than just `{ matches }`.
function setPointer(coarse: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList);
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('MobileAppHandoff', () => {
  beforeEach(() => {
    localStorage.clear();
    setPointer(true);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true });
  });

  describe('when it stays out of the way', () => {
    it('renders nothing on a fine-pointer device', () => {
      setPointer(false);
      stubLocation('/notes/note-1');

      const { container } = render(<MobileAppHandoff />);

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByTestId('mobile-app-handoff-prompt')).not.toBeInTheDocument();
    });

    it('renders nothing for a path the mobile app has no screen for', () => {
      stubLocation('/');

      render(<MobileAppHandoff />);

      expect(screen.queryByTestId('mobile-app-handoff-prompt')).not.toBeInTheDocument();
    });

    it('renders nothing on settings, which the app can deep link but nobody shares', () => {
      stubLocation('/settings');

      const { container } = render(<MobileAppHandoff />);

      expect(container).toBeEmptyDOMElement();
    });

    it('does not hand off from settings even once the app is known installed', () => {
      setMobileAppKnownInstalled(true);
      const assigned = stubLocation('/settings');

      render(<MobileAppHandoff />);

      expect(assigned).toEqual([]);
    });

    it('renders nothing once dismissed on this device', () => {
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);
      expect(screen.getByTestId('mobile-app-handoff-prompt')).toBeInTheDocument();

      screen.getByTestId('mobile-app-handoff-stay').click();

      const remounted = render(<MobileAppHandoff />);
      expect(remounted.container).toBeEmptyDOMElement();
    });
  });

  describe('first arrival', () => {
    it('prompts instead of navigating', () => {
      const assigned = stubLocation('/notes/note-1');

      render(<MobileAppHandoff />);

      expect(screen.getByTestId('mobile-app-handoff-prompt')).toBeInTheDocument();
      expect(assigned).toEqual([]);
    });

    it('names the server so a multi-server user knows where the link points', () => {
      stubLocation('/notes/note-1');

      render(<MobileAppHandoff />);

      expect(screen.getByText(/jot\.example\.com/)).toBeInTheDocument();
    });

    it('hands off when the visitor opts in', async () => {
      const user = userEvent.setup();
      const assigned = stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);

      await user.click(screen.getByTestId('mobile-app-handoff-open'));

      expect(assigned).toEqual([NOTE_DEEP_LINK]);
      expect(screen.getByTestId('mobile-app-handoff-attempting')).toBeInTheDocument();
    });

    it('records a dismissal so it never asks again', async () => {
      const user = userEvent.setup();
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);

      await user.click(screen.getByTestId('mobile-app-handoff-stay'));

      expect(isMobileAppHandoffDismissed()).toBe(true);
      expect(screen.queryByTestId('mobile-app-handoff-prompt')).not.toBeInTheDocument();
    });
  });

  describe('once the app is known to be installed', () => {
    beforeEach(() => {
      setMobileAppKnownInstalled(true);
    });

    it('hands off immediately without prompting', () => {
      const assigned = stubLocation('/notes/note-1');

      render(<MobileAppHandoff />);

      expect(assigned).toContain(NOTE_DEEP_LINK);
      expect(screen.getByTestId('mobile-app-handoff-attempting')).toBeInTheDocument();
      expect(screen.queryByTestId('mobile-app-handoff-prompt')).not.toBeInTheDocument();
    });

    it('clears the overlay when the browser is backgrounded', () => {
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);

      act(() => setVisibility('hidden'));

      expect(screen.queryByTestId('mobile-app-handoff-attempting')).not.toBeInTheDocument();
      expect(isMobileAppKnownInstalled()).toBe(true);
    });

    it('falls back to the prompt and forgets the app when nothing answers', () => {
      vi.useFakeTimers();
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);

      act(() => {
        vi.advanceTimersByTime(HANDOFF_TIMEOUT_MS);
      });

      expect(screen.getByTestId('mobile-app-handoff-prompt')).toBeInTheDocument();
      expect(screen.getByTestId('mobile-app-handoff-failed')).toBeInTheDocument();
      // A stale flag would otherwise stall every future arrival for 1.5s.
      expect(isMobileAppKnownInstalled()).toBe(false);
    });

    it('treats an already-backgrounded browser at timeout as a success', () => {
      vi.useFakeTimers();
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);

      // Background the page without the event landing, then let the timer run.
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      act(() => {
        vi.advanceTimersByTime(HANDOFF_TIMEOUT_MS);
      });

      expect(screen.queryByTestId('mobile-app-handoff-prompt')).not.toBeInTheDocument();
      expect(isMobileAppKnownInstalled()).toBe(true);
    });
  });
});
