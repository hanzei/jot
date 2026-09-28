import type { TFunction } from 'i18next';
import { parseApiError, type ApiErrorCode } from '@jot/shared';

/**
 * Error codes the webapp shows its own translated message for. Any other code
 * shows the server's message (English, but specific — e.g. which validation
 * rule failed), except `internal`, whose message is always the masked
 * "internal server error" and so falls back to the caller's generic text.
 */
const API_ERROR_MESSAGE_KEYS: Partial<Record<ApiErrorCode, string>> = {
  invalid_credentials: 'apiErrors.invalidCredentials',
  registration_disabled: 'apiErrors.registrationDisabled',
  local_login_disabled: 'apiErrors.localLoginDisabled',
  incorrect_password: 'apiErrors.incorrectPassword',
  username_taken: 'apiErrors.usernameTaken',
  cannot_share_with_self: 'share.cannotShareSelf',
  already_shared: 'share.alreadyShared',
  label_name_taken: 'apiErrors.labelNameTaken',
  last_admin: 'apiErrors.lastAdmin',
  cannot_delete_self: 'apiErrors.cannotDeleteSelf',
  sso_identity_linked: 'settings.ssoLinkConflict',
  would_strand_account: 'apiErrors.wouldStrandAccount',
  sso_unlink_unavailable: 'settings.ssoUnlinkUnavailable',
  rate_limited: 'apiErrors.rateLimited',
  request_too_large: 'apiErrors.requestTooLarge',
};

/**
 * The message to show for a failed API request: a translation for a code the
 * webapp knows, else the server's message, else `t(fallbackKey)` (for a
 * network error, a 5xx, or a response without an error envelope).
 */
export function apiErrorMessage(err: unknown, t: TFunction, fallbackKey: string): string {
  const detail = parseApiError(err);
  if (detail) {
    const key = API_ERROR_MESSAGE_KEYS[detail.code];
    if (key) return t(key);
    if (detail.code !== 'internal' && detail.message.trim()) return detail.message.trim();
  }
  return t(fallbackKey);
}
