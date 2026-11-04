/**
 * Every REST path the clients call, relative to {@link API_BASE_PATH}.
 *
 * Mobile's offline sync queue persists these strings in SQLite and replays
 * them later, possibly after an app update. A builder's output must therefore
 * stay byte-for-byte stable: changing one silently re-targets entries already
 * queued on users' devices. `__tests__/apiPaths.test.ts` pins every one.
 */

/** Prefix the server mounts the API under; `apiPaths` are relative to it. */
export const API_BASE_PATH = '/api/v1';

/**
 * Absolute URL for an `apiPaths` entry, for requests that don't go through a
 * client's axios instance (`<img>` sources, downloads, a server that isn't
 * the active one yet). Without `origin` it is same-origin (`/api/v1/...`).
 */
export function apiUrl(path: string, origin = ''): string {
  // A loop rather than /\/+$/, which backtracks quadratically on long runs of '/'.
  let end = origin.length;
  while (end > 0 && origin[end - 1] === '/') end--;
  return origin.slice(0, end) + API_BASE_PATH + path;
}

export const apiPaths = {
  config: '/config',
  about: '/about',

  login: '/login',
  register: '/register',
  logout: '/logout',

  // The login and link flows are browser redirects, not XHR calls.
  oidcLogin: '/auth/oidc/login',
  oidcLink: '/auth/oidc/link',
  oidcUnlink: '/auth/oidc/unlink',
  oidcNativeExchange: '/auth/oidc/native/exchange',
  oidcNativeLink: '/auth/oidc/native/link',

  notes: '/notes',
  notesTrash: '/notes/trash',
  notesReorder: '/notes/reorder',
  notesImport: '/notes/import',
  notesExport: '/notes/export',
  note: (noteId: string): string => `/notes/${noteId}`,
  /** `DELETE` target for a permanent delete, query string included, as the sync queue stores it. */
  notePermanentDelete: (noteId: string): string => `/notes/${noteId}?permanent=true`,
  noteRestore: (noteId: string): string => `/notes/${noteId}/restore`,
  noteViewed: (noteId: string): string => `/notes/${noteId}/viewed`,
  noteDuplicate: (noteId: string): string => `/notes/${noteId}/duplicate`,
  noteConvert: (noteId: string): string => `/notes/${noteId}/convert`,
  noteShare: (noteId: string): string => `/notes/${noteId}/share`,
  noteShares: (noteId: string): string => `/notes/${noteId}/shares`,
  noteShareUser: (noteId: string, userId: string): string => `/notes/${noteId}/shares/${userId}`,
  noteLabels: (noteId: string): string => `/notes/${noteId}/labels`,
  noteLabel: (noteId: string, labelId: string): string => `/notes/${noteId}/labels/${labelId}`,
  noteImages: (noteId: string): string => `/notes/${noteId}/images`,
  noteItems: (noteId: string): string => `/notes/${noteId}/items`,
  noteItem: (noteId: string, itemId: string): string => `/notes/${noteId}/items/${itemId}`,
  noteItemsReorder: (noteId: string): string => `/notes/${noteId}/items/reorder`,
  noteItemsSetCompleted: (noteId: string): string => `/notes/${noteId}/items/set-completed`,
  noteItemsDelete: (noteId: string): string => `/notes/${noteId}/items/delete`,

  labels: '/labels',
  label: (labelId: string): string => `/labels/${labelId}`,

  users: '/users',
  /** `GET` reads the signed-in user, `PATCH` updates them. */
  usersMe: '/users/me',
  usersMePassword: '/users/me/password',
  usersMeProfileIcon: '/users/me/profile-icon',

  sessions: '/sessions',
  session: (sessionId: string): string => `/sessions/${sessionId}`,

  pats: '/pats',
  pat: (patId: string): string => `/pats/${patId}`,

  image: (imageId: string): string => `/images/${imageId}`,
  imageThumbnail: (imageId: string): string => `/images/${imageId}/thumbnail`,

  adminStats: '/admin/stats',
  adminUsers: '/admin/users',
  adminUser: (userId: string): string => `/admin/users/${userId}`,
  adminUserRole: (userId: string): string => `/admin/users/${userId}/role`,
  adminUserPassword: (userId: string): string => `/admin/users/${userId}/password`,
} as const;
