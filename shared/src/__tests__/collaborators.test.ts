import { describe, it, expect } from 'vitest';
import { buildCollaborators, displayName } from '../collaborators';
import type { Collaborator } from '../collaborators';
import type { User, NoteShare } from '../types';

function makeUser(overrides: Partial<User> & { id: string; username: string }): User {
  return {
    first_name: '',
    last_name: '',
    role: 'user',
    has_profile_icon: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeShare(overrides: Partial<NoteShare> & { shared_with_user_id: string }): NoteShare {
  return {
    id: 's1',
    note_id: 'n1',
    shared_by_user_id: 'owner',
    permission_level: 'edit',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('displayName', () => {
  it('returns full name when both first and last are present', () => {
    const c: Collaborator = { userId: 'u1', username: 'john', firstName: 'John', lastName: 'Doe' };
    expect(displayName(c)).toBe('John Doe');
  });

  it('returns first name only when last name is absent', () => {
    const c: Collaborator = { userId: 'u1', username: 'john', firstName: 'John' };
    expect(displayName(c)).toBe('John');
  });

  it('returns last name only when first name is absent', () => {
    const c: Collaborator = { userId: 'u1', username: 'john', lastName: 'Doe' };
    expect(displayName(c)).toBe('Doe');
  });

  it('falls back to username when no names provided', () => {
    const c: Collaborator = { userId: 'u1', username: 'john' };
    expect(displayName(c)).toBe('john');
  });
});

describe('buildCollaborators', () => {
  it('returns owner as first collaborator', () => {
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice', first_name: 'Alice' }));

    const result = buildCollaborators('owner-id', [], usersById);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      userId: 'owner-id',
      username: 'alice',
      firstName: 'Alice',
      lastName: '',
      hasProfileIcon: false,
    });
  });

  it('includes shared users after the owner', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'bob' }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));
    usersById.set('user-2', makeUser({ id: 'user-2', username: 'bob', first_name: 'Bob', last_name: 'Smith' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result).toHaveLength(2);
    expect(result[1].username).toBe('bob');
    expect(result[1].firstName).toBe('Bob');
    expect(result[1].lastName).toBe('Smith');
  });

  it('prefers usersById data over share data', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'old_bob', first_name: 'OldBob' }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));
    usersById.set('user-2', makeUser({ id: 'user-2', username: 'bob', first_name: 'Bob' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result[1].username).toBe('bob');
    expect(result[1].firstName).toBe('Bob');
  });

  it('falls back to share data when user not in usersById', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'bob', first_name: 'Bob' }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result[1].username).toBe('bob');
    expect(result[1].firstName).toBe('Bob');
  });

  it('deduplicates when owner appears in shared list', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'owner-id', username: 'alice' }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result).toHaveLength(1);
  });

  it('returns "?" when owner is not in usersById', () => {
    const result = buildCollaborators('unknown-id', undefined, new Map());
    expect(result[0].username).toBe('?');
  });

  it('handles undefined usersById', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'bob' }),
    ];

    const result = buildCollaborators('owner-id', shares, undefined);

    expect(result).toHaveLength(2);
    expect(result[0].username).toBe('?');
    expect(result[1].username).toBe('bob');
  });

  it('handles undefined sharedWith', () => {
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));

    const result = buildCollaborators('owner-id', undefined, usersById);

    expect(result).toHaveLength(1);
  });

  it('handles empty sharedWith array', () => {
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));

    const result = buildCollaborators('owner-id', [], usersById);

    expect(result).toHaveLength(1);
  });

  it('deduplicates when the same user appears multiple times in shared list', () => {
    const shares = [
      makeShare({ id: 's1', shared_with_user_id: 'user-2', username: 'bob' }),
      makeShare({ id: 's2', shared_with_user_id: 'user-2', username: 'bob' }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result).toHaveLength(2);
  });

  it('uses hasProfileIcon from share when user is not in usersById', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'bob', has_profile_icon: true }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result[1].hasProfileIcon).toBe(true);
  });
});
