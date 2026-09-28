import { IMAGE_MAX_PER_NOTE, VALIDATION } from './constants';
import type { ApiErrorCode, ApiErrorDetail } from './types';

/**
 * Returns the `{code, message}` of an API error envelope body, or null when
 * `data` is not one (a network error, a non-API response, an older server's
 * plain-text body).
 */
export function parseApiErrorBody(data: unknown): ApiErrorDetail | null {
  if (typeof data !== 'object' || data === null) return null;
  const detail = (data as { error?: unknown }).error;
  if (typeof detail !== 'object' || detail === null) return null;
  const { code, message } = detail as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !code || typeof message !== 'string') return null;
  return { code: code as ApiErrorCode, message };
}

/**
 * Returns the `{code, message}` of a failed API request's error envelope, read
 * from an axios-shaped error's `response.data`, or null when there is none.
 * Structural rather than tied to axios, so @jot/shared needs no dependency.
 */
export function parseApiError(err: unknown): ApiErrorDetail | null {
  if (typeof err !== 'object' || err === null) return null;
  const response = (err as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return null;
  return parseApiErrorBody((response as { data?: unknown }).data);
}

/** The error envelope's code for a failed API request, or null. */
export function apiErrorCode(err: unknown): ApiErrorCode | null {
  return parseApiError(err)?.code ?? null;
}

const API_ERROR_PARAMS: Partial<Record<ApiErrorCode, { max: number }>> = {
  label_name_too_long: { max: VALIDATION.LABEL_NAME_MAX_LENGTH },
  item_limit_reached: { max: VALIDATION.ITEM_MAX_COUNT },
  image_limit_reached: { max: IMAGE_MAX_PER_NOTE },
  pat_limit_reached: { max: VALIDATION.PAT_MAX_COUNT },
};

/**
 * Interpolation values for a client's translation of `code`, or undefined when
 * it needs none. The limit codes' translations name the limit (`{{max}}`), as
 * the server's English message does; the value comes from the limits the
 * clients already mirror, since the envelope carries only code and message.
 */
export function apiErrorParams(code: ApiErrorCode): { max: number } | undefined {
  return API_ERROR_PARAMS[code];
}
