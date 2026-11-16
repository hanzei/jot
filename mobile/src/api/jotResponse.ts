/**
 * Telling a response from the Jot server apart from anything else that can
 * answer the same URL (#1266).
 *
 * On a captive portal, a plain-HTTP request is redirected to the portal's login
 * page, which the HTTP stack follows to a `200` HTML response. Counting that as
 * the server answering would mark it reachable, and a queued write "landed"
 * would be deleted although it never reached Jot.
 *
 * Every Jot server (since v0.15.0) returns the incoming `X-Request-Id` verbatim
 * when it is at most 64 characters of `[A-Za-z0-9._-]` (server
 * `internal/server/request_id.go`). The client sends a fresh random ID with each
 * request and counts a response as Jot's only when the same ID comes back. A
 * portal, or a proxy answering on its own, cannot produce a match.
 *
 * Leaf module (imports only `randomUUID`), so the api client, the SSE manager
 * and the server probes can all use it without an import cycle.
 */

import { randomUUID } from '../utils/random';

/** Header carrying the request ID, both ways. Matched case-insensitively. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** A fresh request ID. A UUID fits the server's accepted character set and length. */
export function newRequestId(): string {
  return randomUUID();
}

type HeaderBag = { get?: (name: string) => unknown } & Record<string, unknown>;

/**
 * Reads a header from an axios headers object (`AxiosHeaders`, which has a
 * case-insensitive `get`) or a plain record, whose key case varies by platform.
 */
export function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const bag = headers as HeaderBag;
  let value: unknown;
  if (typeof bag.get === 'function') {
    value = bag.get(name);
  } else {
    const wanted = name.toLowerCase();
    for (const [key, v] of Object.entries(bag)) {
      if (key.toLowerCase() === wanted) {
        value = v;
        break;
      }
    }
  }
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' ? value : null;
}

/** Whether a response carrying `headers` echoes `sentId`, i.e. came from Jot. */
export function echoesRequestId(sentId: string, headers: unknown): boolean {
  return readHeader(headers, REQUEST_ID_HEADER) === sentId;
}

/**
 * Logged once per kind of request whose response was not Jot's, so a support
 * report shows why the server counts as unreachable. Most often a captive
 * portal; persistently, a reverse proxy that overwrites `X-Request-Id`.
 */
export function warnNotJotResponse(what: string, status: number | undefined): void {
  console.warn(
    `${what}: the response${status !== undefined ? ` (HTTP ${status})` : ''} did not echo the request ID, `
    + 'so it did not come from the Jot server (a captive portal, or a proxy that rewrites X-Request-Id). '
    + 'Treating the server as unreachable.',
  );
}
