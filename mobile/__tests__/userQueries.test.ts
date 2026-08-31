/**
 * Tests for the local users store (db/userQueries).
 *
 * The share-target list endpoint (`GET /users`) returns the server's UserInfo
 * shape, which omits created_at/updated_at (server/internal/handlers/users.go),
 * so a listed collaborator's User arrives without those fields even though the
 * shared type declares them required. The upsert must not trip the columns'
 * NOT NULL constraint, and a later timestamp-less list sync must not clobber a
 * real updated_at a profile_icon_updated SSE event previously stored (issue #970).
 */

import { saveUsers, upsertUser, getLocalUsers } from '../src/db/userQueries';
import type { User } from '@jot/shared';
import type { TestDatabase } from './helpers/testDb';

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

function makeUser(id: string, overrides: Partial<User> = {}): User {
  return {
    id,
    username: `user-${id}`,
    first_name: '',
    last_name: '',
    role: 'user',
    has_profile_icon: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

// A user as it arrives from GET /users (UserInfo): no timestamps. Cast because
// the shared User type declares them required, but the endpoint omits them.
function listUser(id: string): User {
  return {
    id,
    username: `user-${id}`,
    first_name: '',
    last_name: '',
    role: 'user',
    has_profile_icon: false,
  } as unknown as User;
}

describe('saveUsers', () => {
  it('persists a user with no timestamps instead of tripping the NOT NULL constraint', async () => {
    await expect(saveUsers(db, [listUser('a')])).resolves.not.toThrow();

    const [stored] = await getLocalUsers(db);
    expect(stored?.id).toBe('a');
    // '' is the schema default and the rowToUser fallback: the sentinel for an
    // unknown timestamp.
    expect(stored?.created_at).toBe('');
    expect(stored?.updated_at).toBe('');
  });

  it('does not clobber an existing real timestamp with a timestamp-less list entry', async () => {
    // A profile_icon_updated SSE event lands first, carrying a real updated_at
    // that avatar cache-busting relies on.
    await upsertUser(db, makeUser('a', { updated_at: '2026-05-05T12:00:00.000Z' }));

    // A subsequent GET /users reconciliation carries the same user without
    // timestamps. It must keep the previously-stored values, not reset them to ''.
    await saveUsers(db, [listUser('a')]);

    const [stored] = await getLocalUsers(db);
    expect(stored?.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(stored?.updated_at).toBe('2026-05-05T12:00:00.000Z');
  });

  it('still applies a fresh non-empty timestamp on conflict', async () => {
    await upsertUser(db, makeUser('a', { updated_at: '2026-05-05T12:00:00.000Z' }));
    await upsertUser(db, makeUser('a', { updated_at: '2026-06-06T12:00:00.000Z' }));

    const [stored] = await getLocalUsers(db);
    expect(stored?.updated_at).toBe('2026-06-06T12:00:00.000Z');
  });
});
