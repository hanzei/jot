import type { SQLiteDatabase } from 'expo-sqlite';
import type { User } from '@jot/shared';
import { withSerializedTransaction } from './transaction';

interface UserRow {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: string;
  has_profile_icon: number;
  created_at: string;
  updated_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role as User['role'],
    has_profile_icon: row.has_profile_icon === 1,
    created_at: row.created_at ?? '',
    updated_at: row.updated_at ?? '',
  };
}

export async function saveUsers(db: SQLiteDatabase, users: User[]): Promise<void> {
  await withSerializedTransaction(db, async () => {
    if (users.length === 0) {
      await db.runAsync('DELETE FROM users');
    } else {
      const placeholders = users.map(() => '?').join(',');
      await db.runAsync(
        `DELETE FROM users WHERE id NOT IN (${placeholders})`,
        users.map((u) => u.id),
      );
    }
    for (const user of users) {
      await db.runAsync(UPSERT_USER_SQL, userUpsertParams(user));
    }
  });
}

// upsertUser writes a single user without touching the rest of the table, unlike
// saveUsers which reconciles the whole list (and deletes anyone absent from it).
// Used to apply a live profile_icon_updated SSE event for one collaborator.
export async function upsertUser(db: SQLiteDatabase, user: User): Promise<void> {
  await db.runAsync(UPSERT_USER_SQL, userUpsertParams(user));
}

// A real upsert (`ON CONFLICT DO UPDATE`), not `INSERT OR REPLACE` — SQLite
// implements REPLACE as DELETE + INSERT, which with `PRAGMA foreign_keys = ON`
// would fire `ON DELETE CASCADE` on any future table that references users(id)
// (see the identical reasoning, and the incident it caused, in noteQueries.ts
// around saveNoteInTx).
//
// created_at/updated_at preserve an existing non-empty value rather than letting
// `excluded` overwrite it with ''. The share-target list endpoint (`GET /users`)
// returns the server's `UserInfo` shape, which omits both timestamps, so those
// fields arrive undefined and bind as '' (see userUpsertParams). A live
// `profile_icon_updated` SSE event, by contrast, carries a real updated_at that
// avatar cache-busting depends on — so a later timestamp-less list sync must not
// clobber it back to ''.
const UPSERT_USER_SQL = `
  INSERT INTO users (id, username, first_name, last_name, role, has_profile_icon, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    role = excluded.role,
    has_profile_icon = excluded.has_profile_icon,
    created_at = COALESCE(NULLIF(excluded.created_at, ''), users.created_at),
    updated_at = COALESCE(NULLIF(excluded.updated_at, ''), users.updated_at)`;

// created_at/updated_at coerce undefined → '' so the bind never lands as NULL and
// trips the columns' NOT NULL constraint. `GET /users` returns UserInfo, which
// has no timestamps, so a listed collaborator's User carries `undefined` here
// even though the shared type declares them required. '' matches the columns'
// schema default and the rowToUser read fallback: the codebase's sentinel for an
// unknown timestamp.
function userUpsertParams(user: User): (string | number)[] {
  return [
    user.id,
    user.username,
    user.first_name,
    user.last_name,
    user.role,
    user.has_profile_icon ? 1 : 0,
    user.created_at ?? '',
    user.updated_at ?? '',
  ];
}

export async function getLocalUsers(db: SQLiteDatabase): Promise<User[]> {
  const rows = await db.getAllAsync<UserRow>('SELECT * FROM users ORDER BY username ASC');
  return rows.map(rowToUser);
}

