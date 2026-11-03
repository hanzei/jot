import { describe, expect, it } from 'vitest';
import { API_BASE_PATH, apiPaths, apiUrl } from '../api';

// Mobile's offline sync queue stores these strings in SQLite and replays them
// after app updates, so every builder's output is pinned byte for byte. A
// failure here means queued entries on users' devices would hit a different
// URL: fix the builder, don't update the expectation.
describe('apiPaths', () => {
  it('pins the base path', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
  });

  it('joins an origin, the base path and a path', () => {
    expect(apiUrl('/users/me')).toBe('/api/v1/users/me');
    expect(apiUrl('/users/me', 'https://jot.example.com')).toBe('https://jot.example.com/api/v1/users/me');
    expect(apiUrl('/users/me', 'https://jot.example.com//')).toBe('https://jot.example.com/api/v1/users/me');
    expect(apiUrl('/users/me', '/'.repeat(100_000) + 'x')).toBe('/'.repeat(100_000) + 'x/api/v1/users/me');
  });

  it('pins every path', () => {
    const n = 'n1';
    const i = 'i2';
    const expected: Record<keyof typeof apiPaths, string> = {
      config: '/config',
      about: '/about',
      login: '/login',
      register: '/register',
      logout: '/logout',
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
      note: '/notes/n1',
      notePermanentDelete: '/notes/n1?permanent=true',
      noteRestore: '/notes/n1/restore',
      noteViewed: '/notes/n1/viewed',
      noteDuplicate: '/notes/n1/duplicate',
      noteConvert: '/notes/n1/convert',
      noteShare: '/notes/n1/share',
      noteShares: '/notes/n1/shares',
      noteShareUser: '/notes/n1/shares/i2',
      noteLabels: '/notes/n1/labels',
      noteLabel: '/notes/n1/labels/i2',
      noteImages: '/notes/n1/images',
      noteItems: '/notes/n1/items',
      noteItem: '/notes/n1/items/i2',
      noteItemsReorder: '/notes/n1/items/reorder',
      noteItemsSetCompleted: '/notes/n1/items/set-completed',
      noteItemsDelete: '/notes/n1/items/delete',
      labels: '/labels',
      label: '/labels/n1',
      users: '/users',
      usersMe: '/users/me',
      usersMePassword: '/users/me/password',
      usersMeProfileIcon: '/users/me/profile-icon',
      usersMeSettings: '/users/me/settings',
      sessions: '/sessions',
      session: '/sessions/n1',
      pats: '/pats',
      pat: '/pats/n1',
      image: '/images/n1',
      imageThumbnail: '/images/n1/thumbnail',
      adminStats: '/admin/stats',
      adminUsers: '/admin/users',
      adminUser: '/admin/users/n1',
      adminUserRole: '/admin/users/n1/role',
      adminUserPassword: '/admin/users/n1/password',
    };

    const actual: Record<string, string> = {};
    for (const [key, value] of Object.entries(apiPaths)) {
      // Builders take (id) or (id, secondId); extra arguments are ignored.
      actual[key] = typeof value === 'function' ? (value as (a: string, b: string) => string)(n, i) : value;
    }
    expect(actual).toEqual(expected);
  });
});
