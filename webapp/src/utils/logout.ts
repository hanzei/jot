import { auth } from '@/utils/api';
import { httpStatus } from '@/utils/apiError';

/**
 * Calls `POST /logout` and reports whether the server session is over. A 401
 * counts: the session had already ended. Anything else that fails — above all
 * an unreachable server — leaves the session alive, and with it the HttpOnly
 * cookie only the server's answer can clear.
 */
// The logout request in flight, if any. Its response clears the session
// cookie, so a sign-in must not race it: if the login response landed first,
// the logout response would then delete the new session's cookie.
let inFlight: Promise<boolean> | null = null;

export const endServerSession = (): Promise<boolean> => {
  inFlight ??= (async () => {
    try {
      // A 401 is handled here, so the interceptor must not also redirect.
      await auth.logout({ skipAuthRedirect: true });
      return true;
    } catch (err) {
      return httpStatus(err) === 401;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};

/** Whether a logout request is still waiting for its response. */
export const isLogoutInFlight = (): boolean => inFlight !== null;

/**
 * Resolves once no logout request is in flight. Every way of signing in
 * awaits this first, so a slow logout retry cannot clear the cookie the new
 * session just set.
 */
export const logoutSettled = async (): Promise<void> => {
  await inFlight;
};
