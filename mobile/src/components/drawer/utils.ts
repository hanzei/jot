import { parseApiError } from '@jot/shared';
import i18n from '../../i18n';
import { displayMessage, extractApiError } from '../../i18n/utils';

/**
 * The message to alert for a failed label mutation: the API error's message
 * (translated where the app knows its code), else a local error's own message
 * (label mutations are local-first, so most failures never reach the server),
 * else `fallback`.
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  const apiMessage = extractApiError(error);
  if (apiMessage) {
    return displayMessage(i18n.t, apiMessage);
  }
  // An API error with nothing worth showing (a 5xx) gets the fallback rather
  // than axios' own "Request failed with status code 500".
  if (parseApiError(error) === null && error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
