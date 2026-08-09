import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOBILE_APP_HANDOFF_DISMISSED_KEY,
  MOBILE_APP_INSTALLED_KEY,
  dismissMobileAppHandoff,
  isHandoffCapableDevice,
  isMobileAppHandoffDismissed,
  isMobileAppKnownInstalled,
  setMobileAppKnownInstalled,
} from '../mobileAppHandoff';

describe('mobileAppHandoff', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('installed flag', () => {
    it('defaults to not installed', () => {
      expect(isMobileAppKnownInstalled()).toBe(false);
    });

    it('round-trips through localStorage', () => {
      setMobileAppKnownInstalled(true);
      expect(localStorage.getItem(MOBILE_APP_INSTALLED_KEY)).toBe('1');
      expect(isMobileAppKnownInstalled()).toBe(true);
    });

    it('clears the key rather than storing a falsy value', () => {
      setMobileAppKnownInstalled(true);
      setMobileAppKnownInstalled(false);
      expect(localStorage.getItem(MOBILE_APP_INSTALLED_KEY)).toBeNull();
      expect(isMobileAppKnownInstalled()).toBe(false);
    });
  });

  describe('dismissal flag', () => {
    it('defaults to not dismissed', () => {
      expect(isMobileAppHandoffDismissed()).toBe(false);
    });

    it('persists a dismissal', () => {
      dismissMobileAppHandoff();
      expect(localStorage.getItem(MOBILE_APP_HANDOFF_DISMISSED_KEY)).toBe('1');
      expect(isMobileAppHandoffDismissed()).toBe(true);
    });
  });

  describe('blocked storage', () => {
    it('reads as un-learned rather than throwing', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });

      expect(isMobileAppKnownInstalled()).toBe(false);
      expect(isMobileAppHandoffDismissed()).toBe(false);
    });

    it('swallows write failures', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });

      expect(() => setMobileAppKnownInstalled(true)).not.toThrow();
      expect(() => dismissMobileAppHandoff()).not.toThrow();
    });
  });

  describe('isHandoffCapableDevice', () => {
    it('follows the coarse-pointer media query', () => {
      const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);

      expect(isHandoffCapableDevice()).toBe(true);
      expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)');

      matchMedia.mockReturnValue({ matches: false } as MediaQueryList);
      expect(isHandoffCapableDevice()).toBe(false);
    });

    it('returns false when matchMedia is unavailable', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation(() => {
        throw new Error('unsupported');
      });

      expect(isHandoffCapableDevice()).toBe(false);
    });
  });
});
