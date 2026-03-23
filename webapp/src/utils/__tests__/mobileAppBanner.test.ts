import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissMobileAppBanner, isMobileAppBannerDismissed } from '../mobileAppBanner';

describe('mobileAppBanner utilities', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false by default', () => {
    expect(isMobileAppBannerDismissed()).toBe(false);
  });

  it('persists dismissal', () => {
    dismissMobileAppBanner();
    expect(isMobileAppBannerDismissed()).toBe(true);
  });

  it('swallows storage exceptions safely', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    expect(isMobileAppBannerDismissed()).toBe(false);
    expect(() => dismissMobileAppBanner()).not.toThrow();

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });
});
