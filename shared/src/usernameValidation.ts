import { USERNAME_EDGE_PATTERN, USERNAME_PATTERN, VALIDATION } from './constants';

export type UsernameValidationErrorCode = 'min' | 'max' | 'chars' | 'edge';

export const getUsernameValidationError = (username: string): UsernameValidationErrorCode | null => {
  if (username.length < VALIDATION.USERNAME_MIN_LENGTH) {
    return 'min';
  }
  if (username.length > VALIDATION.USERNAME_MAX_LENGTH) {
    return 'max';
  }
  if (!USERNAME_PATTERN.test(username)) {
    return 'chars';
  }
  if (USERNAME_EDGE_PATTERN.test(username)) {
    return 'edge';
  }
  return null;
};
