import { canonicalizeServerOrigin } from '@jot/shared';

const NOTE_PATH_PATTERN = /^\/notes\/([^/?#]+)\/?$/;

export function mapWebPathToMobilePath(pathname: string): string {
  if (pathname === '/settings' || pathname === '/settings/') {
    return 'settings';
  }

  const noteMatch = pathname.match(NOTE_PATH_PATTERN);
  if (noteMatch) {
    return `notes/${noteMatch[1]}`;
  }

  return '';
}

export function buildMobileDeepLink(pathname: string, serverOrigin: string): string {
  const mobilePath = mapWebPathToMobilePath(pathname);
  const normalizedOrigin = canonicalizeServerOrigin(serverOrigin);
  const base = mobilePath ? `jot://${mobilePath}` : 'jot://';
  const url = new URL(base);
  if (normalizedOrigin) {
    url.searchParams.set('server', normalizedOrigin);
  }
  return url.toString();
}
