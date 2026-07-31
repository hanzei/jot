import { PASSWORD_MIN_LENGTH } from '@jot/shared';

export const isPasswordTooShort = (password: string, minLength = PASSWORD_MIN_LENGTH): boolean => (
  password.length < minLength
);
