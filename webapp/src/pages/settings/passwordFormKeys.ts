const CHANGE_PASSWORD_KEYS = {
  title: 'settings.changePasswordSection',
  submit: 'settings.changePassword',
  saving: 'settings.changing',
  success: 'settings.passwordChanged',
  failed: 'settings.failedChangePassword',
} as const;

const SET_PASSWORD_KEYS = {
  title: 'settings.setPasswordSection',
  submit: 'settings.setPassword',
  saving: 'settings.saving',
  success: 'settings.passwordSet',
  failed: 'settings.failedSetPassword',
} as const;

/**
 * Translation keys for the two variants of the password card: Change Password,
 * and Set Password for an account with no password yet (`has_password` false).
 */
export const passwordFormKeys = (hasPassword: boolean) =>
  (hasPassword ? CHANGE_PASSWORD_KEYS : SET_PASSWORD_KEYS);
