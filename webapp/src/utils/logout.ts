import { auth } from '@/utils/api';
import { httpStatus } from '@/utils/apiError';

/**
 * Calls `POST /logout` and reports whether the server session is over. A 401
 * counts: the session had already ended. Anything else that fails — above all
 * an unreachable server — leaves the session alive, and with it the HttpOnly
 * cookie only the server's answer can clear.
 */
export const endServerSession = async (): Promise<boolean> => {
  try {
    await auth.logout();
    return true;
  } catch (err) {
    return httpStatus(err) === 401;
  }
};
