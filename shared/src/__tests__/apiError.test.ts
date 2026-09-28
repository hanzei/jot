import { describe, expect, it } from 'vitest';
import { apiErrorCode, apiErrorParams, parseApiError, parseApiErrorBody } from '../apiError';
import { IMAGE_MAX_PER_NOTE, VALIDATION } from '../constants';

const envelope = { error: { code: 'not_found', message: 'note not found' } };

describe('parseApiErrorBody', () => {
  it('returns code and message of an envelope', () => {
    expect(parseApiErrorBody(envelope)).toEqual({ code: 'not_found', message: 'note not found' });
  });

  it.each([
    ['a plain-text body', 'note not found\n'],
    ['null', null],
    ['undefined', undefined],
    ['an object without error', { message: 'x' }],
    ['a non-object error', { error: 'x' }],
    ['a missing code', { error: { message: 'x' } }],
    ['an empty code', { error: { code: '', message: 'x' } }],
    ['a non-string message', { error: { code: 'not_found', message: 1 } }],
  ])('returns null for %s', (_label, data) => {
    expect(parseApiErrorBody(data)).toBeNull();
  });
});

describe('parseApiError', () => {
  it('reads response.data of an axios-shaped error', () => {
    const err = Object.assign(new Error('Request failed'), { response: { status: 404, data: envelope } });
    expect(parseApiError(err)).toEqual({ code: 'not_found', message: 'note not found' });
  });

  it('returns null without a response', () => {
    expect(parseApiError(new Error('Network Error'))).toBeNull();
    expect(parseApiError(null)).toBeNull();
    expect(parseApiError('boom')).toBeNull();
  });
});

describe('apiErrorCode', () => {
  it('returns the code or null', () => {
    expect(apiErrorCode({ response: { data: envelope } })).toBe('not_found');
    expect(apiErrorCode({ response: { data: 'plain' } })).toBeNull();
  });
});

describe('apiErrorParams', () => {
  it.each([
    ['label_name_too_long', VALIDATION.LABEL_NAME_MAX_LENGTH],
    ['item_limit_reached', VALIDATION.ITEM_MAX_COUNT],
    ['image_limit_reached', IMAGE_MAX_PER_NOTE],
    ['pat_limit_reached', VALIDATION.PAT_MAX_COUNT],
  ] as const)('names the limit for %s', (code, max) => {
    expect(apiErrorParams(code)).toEqual({ max });
  });

  it('returns undefined for a code without parameters', () => {
    expect(apiErrorParams('label_name_taken')).toBeUndefined();
  });
});
