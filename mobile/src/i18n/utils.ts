import type { TFunction } from 'i18next';
import { parseApiError, type ApiErrorCode } from '@jot/shared';
import i18n from './index';

export function displayMessage(t: TFunction, message: string): string {
  return i18n.exists(message) ? t(message) : message;
}

export function getCurrentLocale(): string | undefined {
  return i18n.resolvedLanguage || i18n.language || undefined;
}

/**
 * Error codes the app shows its own translated message for. Any other code
 * shows the server's message (English, but specific — e.g. which validation
 * rule failed).
 */
const API_ERROR_MESSAGE_KEYS: Partial<Record<ApiErrorCode, string>> = {
  invalid_credentials: 'apiErrors.invalidCredentials',
  registration_disabled: 'apiErrors.registrationDisabled',
  local_login_disabled: 'apiErrors.localLoginDisabled',
  incorrect_password: 'apiErrors.incorrectPassword',
  username_taken: 'apiErrors.usernameTaken',
  label_name_taken: 'apiErrors.labelNameTaken',
  sso_identity_linked: 'settings.ssoLinkConflict',
  would_strand_account: 'settings.ssoUnlinkWouldStrand',
  sso_link_unavailable: 'settings.ssoLinkUnavailable',
  sso_unlink_unavailable: 'settings.ssoUnlinkUnavailable',
  rate_limited: 'apiErrors.rateLimited',
  request_too_large: 'apiErrors.requestTooLarge',
};

/**
 * The message for a failed API request, for {@link displayMessage}: an i18n
 * key for a code the app translates, else the server's message. Undefined
 * when there is nothing better than the caller's own fallback — no error
 * envelope (network error, older server), or a 5xx, whose message is always
 * the masked "internal server error".
 */
export function extractApiError(err: unknown): string | undefined {
  const detail = parseApiError(err);
  if (!detail || detail.code === 'internal') return undefined;
  const key = API_ERROR_MESSAGE_KEYS[detail.code];
  if (key) return key;
  return detail.message.trim() || undefined;
}
