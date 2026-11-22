import { describe, expect, it } from 'vitest';
import { canonicalizeServerOrigin, createServerId, isInsecureServerOrigin } from '../serverUrl';

describe('canonicalizeServerOrigin', () => {
  it('normalizes scheme/host casing and trims surrounding whitespace', () => {
    expect(canonicalizeServerOrigin('  HTTPS://Example.COM  ')).toBe('https://example.com');
  });

  it('normalizes to origin-only identity and strips path/query/hash', () => {
    expect(canonicalizeServerOrigin('https://example.com/path?a=1#frag')).toBe('https://example.com');
  });

  it('treats default HTTP/HTTPS ports as implicit', () => {
    expect(canonicalizeServerOrigin('http://example.com:80')).toBe('http://example.com');
    expect(canonicalizeServerOrigin('https://example.com:443')).toBe('https://example.com');
  });

  it('preserves explicit non-default ports', () => {
    expect(canonicalizeServerOrigin('https://example.com:8443/path')).toBe('https://example.com:8443');
    expect(canonicalizeServerOrigin('http://example.com:8080')).toBe('http://example.com:8080');
  });

  it('rejects unsupported protocols and malformed URLs', () => {
    expect(canonicalizeServerOrigin('ftp://example.com')).toBeNull();
    expect(canonicalizeServerOrigin('example.com')).toBeNull();
    expect(canonicalizeServerOrigin('')).toBeNull();
  });
});

describe('createServerId', () => {
  it('is deterministic for the same canonical origin', () => {
    const origin = 'https://example.com';
    expect(createServerId(origin)).toBe(createServerId(origin));
  });

  it('produces different IDs for different canonical origins', () => {
    expect(createServerId('https://example.com')).not.toBe(createServerId('https://example.org'));
  });
});

describe('isInsecureServerOrigin', () => {
  it('flags plain HTTP to a network host', () => {
    expect(isInsecureServerOrigin('http://jot.example.com')).toBe(true);
    expect(isInsecureServerOrigin('HTTP://192.168.1.20:8080/path')).toBe(true);
  });

  it('flags the Android emulator alias, which is also a LAN address', () => {
    expect(isInsecureServerOrigin('http://10.0.2.2:8080')).toBe(true);
  });

  it('does not flag HTTPS', () => {
    expect(isInsecureServerOrigin('https://jot.example.com')).toBe(false);
    expect(isInsecureServerOrigin('https://10.0.2.2:8443')).toBe(false);
  });

  it('does not flag loopback hosts', () => {
    expect(isInsecureServerOrigin('http://localhost:8080')).toBe(false);
    expect(isInsecureServerOrigin('http://LOCALHOST')).toBe(false);
    expect(isInsecureServerOrigin('http://127.0.0.1:8080')).toBe(false);
    expect(isInsecureServerOrigin('http://[::1]:8080')).toBe(false);
  });

  it('does not flag input that is not a server URL', () => {
    expect(isInsecureServerOrigin('')).toBe(false);
    expect(isInsecureServerOrigin('not a url')).toBe(false);
    expect(isInsecureServerOrigin('ftp://jot.example.com')).toBe(false);
  });
});
