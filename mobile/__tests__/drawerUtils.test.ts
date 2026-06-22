import { extractErrorMessage } from '../src/components/drawer/utils';

describe('extractErrorMessage', () => {
  it('returns fallback for non-object errors', () => {
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(42, 'fallback')).toBe('fallback');
    expect(extractErrorMessage('oops', 'fallback')).toBe('fallback');
  });

  it('extracts message from an Error instance', () => {
    expect(extractErrorMessage(new Error('something went wrong'), 'fallback')).toBe('something went wrong');
  });

  it('returns fallback for an Error with an empty message', () => {
    expect(extractErrorMessage(new Error(''), 'fallback')).toBe('fallback');
  });

  it('extracts a string response body', () => {
    expect(extractErrorMessage({ response: { data: 'server error' } }, 'fallback')).toBe('server error');
  });

  it('trims string response body', () => {
    expect(extractErrorMessage({ response: { data: '  trimmed  ' } }, 'fallback')).toBe('trimmed');
  });

  it('returns fallback for a whitespace-only string body', () => {
    expect(extractErrorMessage({ response: { data: '   ' } }, 'fallback')).toBe('fallback');
  });

  it('extracts response.data.message from object body', () => {
    expect(extractErrorMessage({ response: { data: { message: 'bad request' } } }, 'fallback')).toBe('bad request');
  });

  it('extracts response.data.error when message is absent', () => {
    expect(extractErrorMessage({ response: { data: { error: 'not found' } } }, 'fallback')).toBe('not found');
  });

  it('extracts response.data.detail when message and error are absent', () => {
    expect(extractErrorMessage({ response: { data: { detail: 'forbidden' } } }, 'fallback')).toBe('forbidden');
  });

  it('prefers message over error and detail', () => {
    const error = { response: { data: { message: 'msg', error: 'err', detail: 'det' } } };
    expect(extractErrorMessage(error, 'fallback')).toBe('msg');
  });

  it('returns fallback when object body has no recognised fields', () => {
    expect(extractErrorMessage({ response: { data: { code: 404 } } }, 'fallback')).toBe('fallback');
  });

  it('returns fallback when response has no data field', () => {
    expect(extractErrorMessage({ response: {} }, 'fallback')).toBe('fallback');
  });

  it('falls back to error.message when response data yields nothing (axios-style Error)', () => {
    // Axios errors are Error instances that also carry a .response property.
    // When the response data cannot be extracted, error.message is the fallback.
    const axiosLike = Object.assign(new Error('Network Error'), { response: { data: '' } });
    expect(extractErrorMessage(axiosLike, 'fallback')).toBe('Network Error');
  });
});
