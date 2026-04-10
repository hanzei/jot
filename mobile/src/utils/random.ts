/**
 * Platform-safe random utilities.
 *
 * React Native / Hermes does not guarantee that `globalThis.crypto` is present
 * at module-evaluation time (the runtime may not yet be fully initialised when
 * JS modules are first loaded).  These helpers use `Math.random()` so they
 * work unconditionally in every environment.
 *
 * Neither value produced here needs to be cryptographically unpredictable:
 *   - CLIENT_ID  is only used to suppress SSE echo-backs from the server.
 *   - Local note IDs only need to be unique within a single device.
 */

/** Generate a UUID v4 string using Math.random(). */
export function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Fill a Uint8Array with pseudo-random bytes using Math.random(). */
export function getRandomBytes(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
}
