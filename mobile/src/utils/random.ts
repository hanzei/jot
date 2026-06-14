/**
 * Platform-safe random utilities.
 *
 * React Native / Hermes does not guarantee that `globalThis.crypto` is present
 * at module-evaluation time (the runtime may not yet be fully initialised when
 * JS modules are first loaded).  These helpers use `Math.random()` so they
 * work unconditionally in every environment.
 *
 * Neither value produced by `randomUUID`/`getRandomBytes` needs to be
 * cryptographically unpredictable:
 *   - CLIENT_ID  is only used to suppress SSE echo-backs from the server.
 *   - Local note IDs only need to be unique within a single device.
 *
 * `getStrongRandomBytes` is the exception: a client-generated note ID becomes a
 * global server primary key (#475), so it prefers Web Crypto when the runtime
 * exposes it. Unlike module-evaluation time, `globalThis.crypto` is reliably
 * present by the time user-initiated code mints an ID, so this is safe to call
 * at runtime; it falls back to `getRandomBytes` if Web Crypto is unavailable.
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

/**
 * Fill a Uint8Array with cryptographically-strong random bytes when the runtime
 * exposes Web Crypto, falling back to {@link getRandomBytes} otherwise. Use this
 * for values that must be globally unique (e.g. a client-minted note ID that
 * becomes a server primary key, #475), not just device-local.
 */
export function getStrongRandomBytes(bytes: Uint8Array): void {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
    return;
  }
  getRandomBytes(bytes);
}
