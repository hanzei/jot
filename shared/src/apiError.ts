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
  return parseApiErrorBody(responseOf(err)?.data);
}

const REQUEST_ID_HEADER = 'X-Request-Id';

/** The `response` of an axios-shaped error, or null when it has none. */
function responseOf(err: unknown): { status?: unknown; headers?: unknown; data?: unknown } | null {
  if (typeof err !== 'object' || err === null) return null;
  const response = (err as { response?: unknown }).response;
  return typeof response === 'object' && response !== null ? response : null;
}

/**
 * Reads a header from an axios-shaped headers object: an AxiosHeaders instance
 * (case-insensitive `get`) or a plain object, whose keys XHR lowercases.
 */
function readHeader(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const getter = (headers as { get?: unknown }).get;
  const value = typeof getter === 'function'
    ? (getter as (this: unknown, n: string) => unknown).call(headers, name)
    : (headers as Record<string, unknown>)[name.toLowerCase()];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The server's request ID for a failed API request, read from the
 * `X-Request-Id` header of an axios-shaped error's response, or null when there
 * was no response (a network error) or the server sent no ID. Quoting it lets
 * an operator find the matching server log line and trace.
 */
export function apiRequestId(err: unknown): string | null {
  return readHeader(responseOf(err)?.headers, REQUEST_ID_HEADER);
}

/**
 * The request ID of a failed API request that the server answered with a 5xx,
 * or null for any other failure. A server error is the case worth reporting
 * with a reference; a 4xx is the client's own mistake and its message says so.
 */
export function serverErrorRequestId(err: unknown): string | null {
  return isServerError(err) ? apiRequestId(err) : null;
}

/** Whether a failed API request got a 5xx answer from the server. */
export function isServerError(err: unknown): boolean {
  const status = responseOf(err)?.status;
  return typeof status === 'number' && status >= 500;
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
