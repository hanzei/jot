import { VALIDATION } from '@jot/shared';
import i18n from '../src/i18n';
import { LocalizedError, displayMessage, errorMessageKey, extractApiError } from '../src/i18n/utils';
import { apiErrorBody } from './helpers/apiError';

const apiError = (status: number, ...body: Parameters<typeof apiErrorBody>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: apiErrorBody(...body) },
  });

describe('extractApiError', () => {
  it('returns the key of a code the app translates', () => {
    expect(extractApiError(apiError(400, 'label_name_taken', 'label name already exists'))).toBe('apiErrors.labelNameTaken');
    expect(extractApiError(apiError(400, 'invalid_import_file', 'invalid JSON file'))).toBe('apiErrors.invalidImportFile');
  });

  it('returns the trimmed server message for other codes', () => {
    expect(extractApiError(apiError(400, 'validation_failed', '  title must be 200 characters or fewer\n')))
      .toBe('title must be 200 characters or fewer');
  });

  it('returns undefined for an internal error, a non-envelope error, and a local error', () => {
    expect(extractApiError(apiError(500, 'internal', 'internal server error'))).toBeUndefined();
    expect(extractApiError(Object.assign(new Error('Network Error'), { response: { data: '' } }))).toBeUndefined();
    expect(extractApiError(new Error('boom'))).toBeUndefined();
  });
});

describe('errorMessageKey', () => {
  it("returns a LocalizedError's key", () => {
    expect(errorMessageKey(new LocalizedError('labels.nameRequired', 'Label name must not be empty'))).toBe('labels.nameRequired');
  });

  it('returns the API error key or message', () => {
    expect(errorMessageKey(apiError(409, 'label_name_taken', 'label name already exists'))).toBe('apiErrors.labelNameTaken');
  });

  it('returns undefined for an unexpected local error, so its English text is never shown', () => {
    expect(errorMessageKey(new Error('Note n1 not found in local cache'))).toBeUndefined();
    expect(errorMessageKey(null)).toBeUndefined();
    expect(errorMessageKey('oops')).toBeUndefined();
  });
});

describe('displayMessage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('translates a key and passes a limit code its limit', async () => {
    await i18n.changeLanguage('de');
    expect(displayMessage(i18n.t, 'apiErrors.labelNameTooLong'))
      .toBe(`Label-Namen dürfen höchstens ${VALIDATION.LABEL_NAME_MAX_LENGTH} Zeichen lang sein.`);
    expect(displayMessage(i18n.t, 'labels.nameRequired')).toBe('Der Label-Name darf nicht leer sein.');
  });

  it('returns text that is not a key unchanged', () => {
    expect(displayMessage(i18n.t, 'title must be 200 characters or fewer')).toBe('title must be 200 characters or fewer');
  });
});
