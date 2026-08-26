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

    it('withholds the app until the visitor picks the browser', async () => {
      const user = userEvent.setup();
      stubLocation('/notes/note-1');

      render(<MobileAppHandoff><p>the note</p></MobileAppHandoff>);
      expect(screen.queryByText('the note')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('mobile-app-handoff-stay'));

      expect(screen.getByText('the note')).toBeInTheDocument();
    });

    it('renders the app untouched when no handoff applies', () => {
      stubLocation('/');

      render(<MobileAppHandoff><p>the note</p></MobileAppHandoff>);

      expect(screen.getByText('the note')).toBeInTheDocument();
    });

    it('hands off when the visitor opts in', async () => {
      const user = userEvent.setup();
      const assigned = stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);

      await user.click(screen.getByTestId('mobile-app-handoff-open'));

      expect(assigned).toEqual([NOTE_DEEP_LINK]);
      expect(screen.getByTestId('mobile-app-handoff-attempting')).toBeInTheDocument();
    });

    // aria-modal="true" tells assistive tech the rest of the page is inert, so
    // Tab must not walk out of the prompt into the note modal behind it.
    // The button outside the overlay stands in for the note modal behind the
    // scrim, and is what makes these tests mean anything: with only the two
    // prompt buttons in the document, Tab would wrap back into the prompt on
    // its own and pass whether or not a trap exists.
    const renderWithOutsideFocusable = () => {
      stubLocation('/notes/note-1');
      render(
        <>
          <button data-testid="outside">outside</button>
          <MobileAppHandoff />
        </>,
      );
      return {
        open: screen.getByTestId('mobile-app-handoff-open'),
        stay: screen.getByTestId('mobile-app-handoff-stay'),
        outside: screen.getByTestId('outside'),
      };
    };

    it('cycles focus forward at the end of the prompt', async () => {
      const user = userEvent.setup();
      const { open, stay, outside } = renderWithOutsideFocusable();

      expect(open).toHaveFocus();
      await user.tab();
      expect(stay).toHaveFocus();

      await user.tab();
      expect(open).toHaveFocus();
      expect(outside).not.toHaveFocus();
    });

    it('cycles focus backward at the start of the prompt', async () => {
      const user = userEvent.setup();
      const { open, stay, outside } = renderWithOutsideFocusable();

      expect(open).toHaveFocus();
      await user.tab({ shift: true });

      expect(stay).toHaveFocus();
      expect(outside).not.toHaveFocus();
    });

    it('closes on Escape without persisting a dismissal', async () => {
      const user = userEvent.setup();
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff />);

      await user.keyboard('{Escape}');

      expect(screen.queryByTestId('mobile-app-handoff-prompt')).not.toBeInTheDocument();
      expect(isMobileAppHandoffDismissed()).toBe(false);
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

    it('stops at a terminal screen when the browser is backgrounded', () => {
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff><p>the note</p></MobileAppHandoff>);

      act(() => setVisibility('hidden'));

      expect(screen.queryByTestId('mobile-app-handoff-attempting')).not.toBeInTheDocument();
      expect(screen.getByTestId('mobile-app-handoff-done')).toBeInTheDocument();
      expect(isMobileAppKnownInstalled()).toBe(true);
      // The whole point: the abandoned tab must not go on to fetch and render
      // the note for nobody.
      expect(screen.queryByText('the note')).not.toBeInTheDocument();
    });

    it('can still fall through to the browser from the terminal screen', async () => {
      const user = userEvent.setup();
      stubLocation('/notes/note-1');
      render(<MobileAppHandoff><p>the note</p></MobileAppHandoff>);
      act(() => setVisibility('hidden'));

      await user.click(screen.getByTestId('mobile-app-handoff-continue'));

      expect(screen.getByText('the note')).toBeInTheDocument();
      // Unlike the prompt's button of the same name: the handoff just worked,
      // so this is "show me this note here", not "stop offering the app".
      expect(isMobileAppHandoffDismissed()).toBe(false);
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
      expect(screen.getByTestId('mobile-app-handoff-done')).toBeInTheDocument();
      expect(isMobileAppKnownInstalled()).toBe(true);
    });
  });
});
