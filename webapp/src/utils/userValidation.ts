import { PASSWORD_MIN_LENGTH, VALIDATION } from '@jot/shared';

const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export type UsernameValidationErrorCode = 'min' | 'max' | 'chars' | 'edge';

export const getUsernameValidationError = (username: string): UsernameValidationErrorCode | null => {
  if (username.length < VALIDATION.USERNAME_MIN_LENGTH) {
    return 'min';
  }
  if (username.length > VALIDATION.USERNAME_MAX_LENGTH) {
    return 'max';
  }
  if (!USERNAME_REGEX.test(username)) {
    return 'chars';
  }
  if (
    username.startsWith('_') ||
    username.startsWith('-') ||
    username.endsWith('_') ||
    username.endsWith('-')
  ) {
    return 'edge';
  }
  return null;
};

export const isPasswordTooShort = (password: string, minLength = PASSWORD_MIN_LENGTH): boolean => (
  password.length < minLength
);
