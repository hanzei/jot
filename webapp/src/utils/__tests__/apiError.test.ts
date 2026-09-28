import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { apiErrorMessage } from '../apiError';

const t = ((key: string) => `t:${key}`) as unknown as TFunction;

const apiError = (code: string, message: string) => ({
  isAxiosError: true,
  response: { status: 400, data: { error: { code, message } } },
});

describe('apiErrorMessage', () => {
  it('translates a code the webapp knows', () => {
    expect(apiErrorMessage(apiError('cannot_share_with_self', 'cannot share with self'), t, 'share.failedShare'))
      .toBe('t:share.cannotShareSelf');
    expect(apiErrorMessage(apiError('label_name_taken', 'label name already exists'), t, 'labels.renameError'))
      .toBe('t:apiErrors.labelNameTaken');
  });

  it('shows the server message for other codes', () => {
    expect(apiErrorMessage(apiError('validation_failed', ' username must be at least 2 characters\n'), t, 'x.fallback'))
      .toBe('username must be at least 2 characters');
  });

  it('shows an unknown code\'s server message', () => {
    expect(apiErrorMessage(apiError('some_future_code', 'something new'), t, 'x.fallback')).toBe('something new');
  });

  it('falls back for internal errors, empty messages, and non-envelope errors', () => {
    expect(apiErrorMessage(apiError('internal', 'internal server error'), t, 'x.fallback')).toBe('t:x.fallback');
    expect(apiErrorMessage(apiError('not_found', '  '), t, 'x.fallback')).toBe('t:x.fallback');
    expect(apiErrorMessage({ response: { status: 400, data: 'plain text' } }, t, 'x.fallback')).toBe('t:x.fallback');
    expect(apiErrorMessage(new Error('Network Error'), t, 'x.fallback')).toBe('t:x.fallback');
  });
});
