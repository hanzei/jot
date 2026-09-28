import { extractErrorMessage } from '../src/components/drawer/utils';

const apiError = (code: string, message: string) =>
  Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: { status: 400, data: { error: { code, message } } },
  });

describe('extractErrorMessage', () => {
  it('returns fallback for non-object errors', () => {
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(42, 'fallback')).toBe('fallback');
    expect(extractErrorMessage('oops', 'fallback')).toBe('fallback');
  });

  it('extracts message from a local Error instance', () => {
    expect(extractErrorMessage(new Error('something went wrong'), 'fallback')).toBe('something went wrong');
  });

  it('returns fallback for an Error with an empty message', () => {
    expect(extractErrorMessage(new Error(''), 'fallback')).toBe('fallback');
  });

  it('translates an API error code the app knows', () => {
    expect(extractErrorMessage(apiError('label_name_taken', 'label name already exists'), 'fallback'))
      .toBe('A label with this name already exists.');
  });

  it('shows the server message for other API error codes', () => {
    expect(extractErrorMessage(apiError('limit_exceeded', '  label name must be 100 characters or fewer  '), 'fallback'))
      .toBe('label name must be 100 characters or fewer');
  });

  it('returns fallback for an internal API error rather than the axios message', () => {
    expect(extractErrorMessage(apiError('internal', 'internal server error'), 'fallback')).toBe('fallback');
  });

  it('falls back to error.message for an axios error without an envelope', () => {
    const axiosLike = Object.assign(new Error('Network Error'), { response: { data: '' } });
    expect(extractErrorMessage(axiosLike, 'fallback')).toBe('Network Error');
  });
});
