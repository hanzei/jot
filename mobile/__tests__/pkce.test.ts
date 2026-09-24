import * as Crypto from 'expo-crypto';
import {
  base64ToBase64Url,
  computeCodeChallenge,
  createPkcePair,
  encodeBase64Url,
  generateCodeVerifier,
} from '../src/utils/pkce';

const mockGetRandomBytes = Crypto.getRandomBytes as jest.Mock;

describe('pkce', () => {
  it('computes the RFC 7636 Appendix B challenge', async () => {
    await expect(computeCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('encodes the RFC 7636 Appendix B random octets as its verifier', () => {
    const octets = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173,
      187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83,
      132, 141, 121,
    ]);
    expect(encodeBase64Url(octets)).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it.each([0, 1, 2, 3, 4, 5, 31, 32, 33])('encodes %i bytes like Node base64url', (length) => {
    const bytes = new Uint8Array(length).map((_, i) => (i * 97 + 251) & 0xff);
    expect(encodeBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  it('strips padding and swaps the URL-unsafe characters', () => {
    expect(base64ToBase64Url('+/+/ab==')).toBe('-_-_ab');
  });

  it('generates a 43-character unpadded base64url verifier from 32 random bytes', () => {
    const verifier = generateCodeVerifier();
    expect(mockGetRandomBytes).toHaveBeenLastCalledWith(32);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates a different verifier each time', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(20);
  });

  it('pairs a verifier with its S256 challenge', async () => {
    const { codeVerifier, codeChallenge } = await createPkcePair();
    expect(codeChallenge).toBe(await computeCodeChallenge(codeVerifier));
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
