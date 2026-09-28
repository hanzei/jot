import type { ApiErrorCode, ApiErrorResponse } from '@jot/shared';

/** The API's JSON error envelope, as axios puts it in `error.response.data`. */
export function apiErrorBody(code: ApiErrorCode, message: string): ApiErrorResponse {
  return { error: { code, message } };
}
