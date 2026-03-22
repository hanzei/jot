export const MOBILE_APP_BANNER_DISMISSED_KEY = 'jot_mobile_app_banner_dismissed';

export function isMobileAppBannerDismissed(): boolean {
  try {
    return localStorage.getItem(MOBILE_APP_BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissMobileAppBanner(): void {
  try {
    localStorage.setItem(MOBILE_APP_BANNER_DISMISSED_KEY, '1');
  } catch {
    // Ignore persistence failures and keep the current session behavior.
  }
}
