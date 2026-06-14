import { canonicalizeServerOrigin } from '@jot/shared';

export const DEEP_LINK_PREFIXES = ['jot://'];

export function isJotSchemeUrl(url: string): boolean {
  return /^jot:\/\//i.test(url);
}

export function normalizeServerOrigin(url: string): string | null {
  return canonicalizeServerOrigin(url);
}

export function parseDeepLink(url: string): { path: string; hasServerParam: boolean; serverOrigin: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.trim();
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '');
    const path = [host, pathname].filter(Boolean).join('/');
    const serverParam = parsed.searchParams.get('server');
    return {
      path,
      hasServerParam: serverParam !== null,
      serverOrigin: serverParam ? normalizeServerOrigin(serverParam) : null,
    };
  } catch {
    const [withoutScheme, rawQuery = ''] = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').split('?');
    const serverParam = new URLSearchParams(rawQuery).get('server');
    return {
      path: withoutScheme.replace(/^\/+|\/+$/g, ''),
      hasServerParam: serverParam !== null,
      serverOrigin: serverParam ? normalizeServerOrigin(serverParam) : null,
    };
  }
}

export function getDeepLinkPath(url: string): string {
  return parseDeepLink(url).path;
}

export function isProtectedDeepLinkPath(path: string): boolean {
  const normalizedPath = path.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (normalizedPath.length === 0) {
    return true;
  }
  const firstSegment = normalizedPath.split('/')[0];
  return firstSegment === 'notes' || firstSegment === 'share' || firstSegment === 'settings';
}
