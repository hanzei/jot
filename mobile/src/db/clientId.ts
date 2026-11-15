import { getStrongRandomBytes } from '../utils/random';

// Mirrors the server's ID alphabet/length (see server internal/models/id.go) so a
// client-generated note ID is accepted as-is by the server.
const SERVER_ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SERVER_ID_LENGTH = 22;

/**
 * Generate a server-compatible 22-char ID, accepted as a primary key by the
 * server (notes, #475; labels, #546).
 */
export function generateClientId(): string {
  const bytes = new Uint8Array(SERVER_ID_LENGTH);
  getStrongRandomBytes(bytes);
  let id = '';
  for (const byte of bytes) {
    id += SERVER_ID_CHARS[byte % SERVER_ID_CHARS.length];
  }
  return id;
}
