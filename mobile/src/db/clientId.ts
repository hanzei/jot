import { getStrongRandomBytes } from '../utils/random';

// Mirrors the server's ID alphabet/length (see server internal/models/id.go) so a
// client-generated note ID is accepted as-is by the server.
const SERVER_ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SERVER_ID_LENGTH = 22;

/**
 * Generate a server-compatible 22-char note ID. Offline-created notes use this
 * (rather than a `local_*` ID) so the ID is sent as the note's primary key on
 * `POST /notes` and the create replays idempotently — no server-side ID
 * reconciliation is needed because the client ID *is* the server ID (issue #475).
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
