import { describe, expect, it } from 'vitest';

import { getUsernameValidationError } from '../usernameValidation';

describe('getUsernameValidationError', () => {
  it('accepts a lowercase username', () => {
    expect(getUsernameValidationError('ben_schumacher-1')).toBeNull();
  });

  it('rejects uppercase characters', () => {
    // Rejecting upper case on the way in is what keeps usernames
    // case-insensitively unique; rows written before the rule are left as they
    // are. The client mirrors the server rule so the form fails immediately
    // rather than after a round trip.
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
