import * as Crypto from 'expo-crypto';

/**
 * PKCE (RFC 7636, S256) for the mobile SSO hand-off (docs/specs/oidc-sso.md
 * §10.3). The verifier stays in memory for the one flow that minted it; it is
 * never persisted or logged.
 */

// 32 random bytes encode to a 43-character verifier, the RFC 7636 minimum.
const VERIFIER_BYTES = 32;

/** Converts standard base64 to unpadded base64url. */
export function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encodes bytes as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const remaining = bytes.length - i;
    out += BASE64URL_ALPHABET.charAt(b0 >> 2);
    out += BASE64URL_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (remaining > 1) out += BASE64URL_ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    if (remaining > 2) out += BASE64URL_ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}

/** A fresh, cryptographically random `code_verifier` (43 base64url characters). */
export function generateCodeVerifier(): string {
  return encodeBase64Url(Crypto.getRandomBytes(VERIFIER_BYTES));
}

/** `BASE64URL(SHA256(verifier))`, unpadded — the S256 `code_challenge`. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return base64ToBase64Url(digest);
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = generateCodeVerifier();
  return { codeVerifier, codeChallenge: await computeCodeChallenge(codeVerifier) };
}
