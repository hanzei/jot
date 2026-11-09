import { trimTrailingSlashes } from './api/paths';

/** Path of the webapp page that shows a note through its public link. */
export const PUBLIC_NOTE_PATH_PREFIX = '/share/';

/**
 * The URL of a public note link, as people outside the instance open it.
 *
 * `baseUrl` is `public_url` from `GET /config` when the operator set
 * `JOT_PUBLIC_URL`, and otherwise the client's own address
 * (`window.location.origin` on web, the connected server URL on mobile). Web
 * and mobile both build links here so they come out identical.
 */
export function publicNoteUrl(baseUrl: string, token: string): string {
  return trimTrailingSlashes(baseUrl) + PUBLIC_NOTE_PATH_PREFIX + encodeURIComponent(token);
}
