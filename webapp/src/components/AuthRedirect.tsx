import { Navigate, useLocation, useSearchParams } from 'react-router';
import { REDIRECT_PARAM, authPathWithRedirect, safeRedirectTarget } from '@/utils/authRedirect';

/**
 * Bounce an unauthenticated visitor to the login page, remembering the page
 * they asked for so signing in can hand it back.
 *
 * Replaces rather than pushes: the bounce is not somewhere "back" should
 * return to, and going back to a protected route would only bounce again.
 */
export function LoginRedirect() {
  const location = useLocation();
  const target = location.pathname + location.search + location.hash;
  return <Navigate to={authPathWithRedirect('/login', target)} replace />;
}

/**
 * Leave an auth page now that the visitor is signed in, for the page that
 * bounced them here or the dashboard.
 *
 * This is the *only* authority on where a login lands. The auth pages
 * deliberately do not navigate themselves: the route they sit on stops
 * matching them the moment authentication flips, and the redirect that
 * replaces them would race whatever they had just navigated to.
 */
export function PostAuthRedirect() {
  const [searchParams] = useSearchParams();
  return <Navigate to={safeRedirectTarget(searchParams.get(REDIRECT_PARAM))} replace />;
}
