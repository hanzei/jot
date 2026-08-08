import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileAppPreference from '@/components/MobileAppPreference';
import {
  dismissMobileAppHandoff,
  isMobileAppHandoffDismissed,
} from '@/utils/mobileAppHandoff';

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

describe('MobileAppPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    setPointer(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing on a fine pointer, where the handoff can never fire', () => {
    setPointer(false);

    const { container } = render(<MobileAppPreference />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is checked by default, matching a handoff that has not been dismissed', () => {
    render(<MobileAppPreference />);

    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('reflects a dismissal made from the handoff prompt', () => {
    dismissMobileAppHandoff();

    render(<MobileAppPreference />);

    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('turns the handoff off', async () => {
    const user = userEvent.setup();
    render(<MobileAppPreference />);

    await user.click(screen.getByRole('checkbox'));

    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(isMobileAppHandoffDismissed()).toBe(true);
  });

  // The reason this component exists: "Continue in browser" is otherwise a
  // one-way door out of the feature.
  it('turns a dismissed handoff back on', async () => {
    const user = userEvent.setup();
    dismissMobileAppHandoff();
    render(<MobileAppPreference />);

    await user.click(screen.getByRole('checkbox'));

    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(isMobileAppHandoffDismissed()).toBe(false);
  });
});
