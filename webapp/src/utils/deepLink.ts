const NOTE_PATH_PATTERN = /^\/notes\/([^/?#]+)\/?$/;

function normalizeServerOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return origin;
  }
}

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
  const normalizedOrigin = normalizeServerOrigin(serverOrigin);
  const base = mobilePath ? `jot://${mobilePath}` : 'jot://';
  const url = new URL(base);
  url.searchParams.set('server', normalizedOrigin);
  return url.toString();
}
