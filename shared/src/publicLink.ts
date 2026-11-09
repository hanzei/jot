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
  // A loop rather than /\/+$/, which backtracks quadratically on long runs of '/'.
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end--;
  return baseUrl.slice(0, end) + PUBLIC_NOTE_PATH_PREFIX + encodeURIComponent(token);
}
