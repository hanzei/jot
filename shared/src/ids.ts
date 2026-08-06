/**
 * Client-side ID generation matching the server's ID format
 * (see server/internal/models/id.go): a 22-character string drawn from
 * [0-9a-zA-Z].
 *
 * Clients generate list-item IDs locally so a newly created item has a stable
 * identity *before* it is persisted. This is what makes granular per-item
 * updates and offline replay work: a create followed by edits/deletes all refer
 * to the same ID, with no server round-trip required to learn it.
 *
 * Prefers the Web Crypto API when present, falling back to Math.random() for
 * environments where `crypto.getRandomValues` may be unavailable (e.g. React
 * Native at module-evaluation time). Item IDs only need to be unique, not
 * cryptographically unpredictable.
 */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ID_LENGTH = 22;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

/** Generate a 22-character alphanumeric ID in the server's ID format. */
export function generateId(): string {
  // Reject bytes >= maxByte to eliminate modulo bias (mirrors the server).
  const maxByte = 256 - (256 % ID_ALPHABET.length);
  let result = '';
  while (result.length < ID_LENGTH) {
    const bytes = randomBytes(ID_LENGTH - result.length);
    for (const byte of bytes) {
      if (result.length >= ID_LENGTH) {
        break;
      }
      if (byte < maxByte) {
        result += ID_ALPHABET[byte % ID_ALPHABET.length];
      }
    }
  }
  return result;
}

/** Returns true if id matches the server's 22-character [0-9a-zA-Z] ID format. */
export function isValidId(id: string): boolean {
  if (id.length !== ID_LENGTH) {
    return false;
  }
  for (const c of id) {
    if (!ID_ALPHABET.includes(c)) {
      return false;
    }
  }
  return true;
}
