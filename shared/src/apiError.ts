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
