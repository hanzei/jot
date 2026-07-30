import { describe, expect, it } from 'vitest';

import { getUsernameValidationError } from '../userValidation';

describe('getUsernameValidationError', () => {
  it('accepts a lowercase username', () => {
    expect(getUsernameValidationError('ben_schumacher-1')).toBeNull();
  });

  it('rejects uppercase characters', () => {
    // Usernames are case-insensitively unique because upper case cannot be
    // stored at all — the client has to reject it for the same reason the
    // server does, or the form only fails after a round trip.
    expect(getUsernameValidationError('Ben')).toBe('chars');
    expect(getUsernameValidationError('BEN')).toBe('chars');
  });

  it('rejects other disallowed characters', () => {
    expect(getUsernameValidationError('bad*name')).toBe('chars');
  });

  it('rejects a username that starts or ends with an underscore or hyphen', () => {
    expect(getUsernameValidationError('_ben')).toBe('edge');
    expect(getUsernameValidationError('ben-')).toBe('edge');
  });

  it('enforces the length bounds', () => {
    expect(getUsernameValidationError('b')).toBe('min');
    expect(getUsernameValidationError('b'.repeat(31))).toBe('max');
  });
});
