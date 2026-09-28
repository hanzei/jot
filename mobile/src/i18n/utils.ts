import type { TFunction } from 'i18next';
import { apiErrorParams, parseApiError, type ApiErrorCode } from '@jot/shared';
import i18n from './index';

export function displayMessage(t: TFunction, message: string): string {
  return i18n.exists(message) ? t(message, API_ERROR_KEY_PARAMS[message] ?? {}) : message;
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
  label_name_too_long: 'apiErrors.labelNameTooLong',
  item_limit_reached: 'apiErrors.itemLimitReached',
  image_limit_reached: 'apiErrors.imageLimitReached',
  pat_limit_reached: 'apiErrors.patLimitReached',
  unsupported_image_type: 'apiErrors.unsupportedImageType',
  invalid_image: 'apiErrors.invalidImage',
  invalid_import_file: 'apiErrors.invalidImportFile',
};

/**
 * Interpolation values for the keys above whose translation names a limit, so
 * {@link displayMessage} can render them from the key alone.
 */
const API_ERROR_KEY_PARAMS: Record<string, { max: number } | undefined> = Object.fromEntries(
  Object.entries(API_ERROR_MESSAGE_KEYS).map((entry) => [entry[1], apiErrorParams(entry[0] as ApiErrorCode)]),
);

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

/**
 * A local failure with a message worth showing: `messageKey` is the i18n key
 * the UI displays, while `message` stays English for logs.
 */
export class LocalizedError extends Error {
  readonly messageKey: string;

  constructor(messageKey: string, message: string) {
    super(message);
    this.name = 'LocalizedError';
    this.messageKey = messageKey;
  }
}

/**
 * The message for any failed operation, for {@link displayMessage}: a
 * {@link LocalizedError}'s key, else {@link extractApiError}'s result. Undefined
 * when neither applies — an unexpected local error, whose English text is not
 * meant for the user — so the caller shows its own fallback.
 */
export function errorMessageKey(err: unknown): string | undefined {
  if (err instanceof LocalizedError) return err.messageKey;
  return extractApiError(err);
}
