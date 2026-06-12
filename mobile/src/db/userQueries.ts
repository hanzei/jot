import { SQLiteDatabase } from 'expo-sqlite';
import type { User } from '@jot/shared';

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
  await db.withTransactionAsync(async () => {
    for (const user of users) {
      await db.runAsync(
        `INSERT OR REPLACE INTO users (id, username, first_name, last_name, role, has_profile_icon, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, user.username, user.first_name, user.last_name, user.role, user.has_profile_icon ? 1 : 0, user.created_at, user.updated_at],
      );
    }
  });
}

export async function getLocalUsers(db: SQLiteDatabase): Promise<User[]> {
  const rows = await db.getAllAsync<UserRow>('SELECT * FROM users ORDER BY username ASC');
  return rows.map(rowToUser);
}

