import { describe, it, expect } from 'vitest';
import { buildCollaborators, buildShareSuggestions, displayName, recentShareTargets } from '../collaborators';
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
      iconVersion: '',
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
    expect(result[1]!.username).toBe('bob');
    expect(result[1]!.firstName).toBe('Bob');
    expect(result[1]!.lastName).toBe('Smith');
  });

  it('prefers usersById data over share data', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'old_bob', first_name: 'OldBob' }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));
    usersById.set('user-2', makeUser({ id: 'user-2', username: 'bob', first_name: 'Bob' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result[1]!.username).toBe('bob');
    expect(result[1]!.firstName).toBe('Bob');
  });

  it('falls back to share data when user not in usersById', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'bob', first_name: 'Bob' }),
    ];
    const usersById = new Map<string, User>();
    usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'alice' }));

    const result = buildCollaborators('owner-id', shares, usersById);

    expect(result[1]!.username).toBe('bob');
    expect(result[1]!.firstName).toBe('Bob');
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
    expect(result[0]!.username).toBe('?');
  });

  it('handles undefined usersById', () => {
    const shares = [
      makeShare({ shared_with_user_id: 'user-2', username: 'bob' }),
    ];

    const result = buildCollaborators('owner-id', shares, undefined);

    expect(result).toHaveLength(2);
    expect(result[0]!.username).toBe('?');
    expect(result[1]!.username).toBe('bob');
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

    expect(result[1]!.hasProfileIcon).toBe(true);
  });
});

function makeNote(shares: Partial<NoteShare>[]): { shared_with: NoteShare[] } {
  return {
    shared_with: shares.map((s, i) =>
      makeShare({ shared_with_user_id: `user-${i}`, ...s }),
    ),
  };
}

describe('recentShareTargets', () => {
  it('orders collaborators by most recent share', () => {
    const notes = [
      makeNote([{ shared_with_user_id: 'bob', created_at: '2026-01-01T10:00:00Z' }]),
      makeNote([{ shared_with_user_id: 'carol', created_at: '2026-03-01T10:00:00Z' }]),
      makeNote([{ shared_with_user_id: 'dave', created_at: '2026-02-01T10:00:00Z' }]),
    ];

    expect(recentShareTargets(notes, 'owner')).toEqual(['carol', 'dave', 'bob']);
  });

  it('deduplicates a collaborator to their most recent share', () => {
    const notes = [
      makeNote([{ shared_with_user_id: 'bob', created_at: '2026-01-01T10:00:00Z' }]),
      makeNote([{ shared_with_user_id: 'carol', created_at: '2026-02-01T10:00:00Z' }]),
      makeNote([{ shared_with_user_id: 'bob', created_at: '2026-03-01T10:00:00Z' }]),
    ];

    expect(recentShareTargets(notes, 'owner')).toEqual(['bob', 'carol']);
  });

  it('ignores shares the current user did not create', () => {
    const notes = [
      makeNote([
        { shared_with_user_id: 'bob', shared_by_user_id: 'someone-else', created_at: '2026-03-01T10:00:00Z' },
        { shared_with_user_id: 'carol', shared_by_user_id: 'owner', created_at: '2026-01-01T10:00:00Z' },
      ]),
    ];

    expect(recentShareTargets(notes, 'owner')).toEqual(['carol']);
  });

  it('caps the result at the requested limit', () => {
    const notes = [
      makeNote([
        { shared_with_user_id: 'a', created_at: '2026-01-05T10:00:00Z' },
        { shared_with_user_id: 'b', created_at: '2026-01-04T10:00:00Z' },
        { shared_with_user_id: 'c', created_at: '2026-01-03T10:00:00Z' },
      ]),
    ];

    expect(recentShareTargets(notes, 'owner', 2)).toEqual(['a', 'b']);
  });

  it('defaults to at most five collaborators', () => {
    const notes = [
      makeNote(
        Array.from({ length: 8 }, (_, i) => ({
          shared_with_user_id: `user-${i}`,
          created_at: `2026-01-0${i + 1}T10:00:00Z`,
        })),
      ),
    ];

    expect(recentShareTargets(notes, 'owner')).toHaveLength(5);
  });

  it('handles notes without shares, and missing input', () => {
    expect(recentShareTargets([{}, { shared_with: [] }], 'owner')).toEqual([]);
    expect(recentShareTargets(undefined, 'owner')).toEqual([]);
    expect(recentShareTargets([makeNote([{ shared_with_user_id: 'bob' }])], '')).toEqual([]);
  });

  it('does not crash on unparsable timestamps', () => {
    const notes = [
      makeNote([{ shared_with_user_id: 'bob', created_at: 'not-a-date' }]),
      makeNote([{ shared_with_user_id: 'carol', created_at: '2026-01-01T10:00:00Z' }]),
    ];

    expect(recentShareTargets(notes, 'owner')).toEqual(['carol', 'bob']);
  });
});

describe('buildShareSuggestions', () => {
  const alice = makeUser({ id: 'alice', username: 'alice' });
  const bob = makeUser({ id: 'bob', username: 'bob', first_name: 'Bob', last_name: 'Smith' });
  const carol = makeUser({ id: 'carol', username: 'carol' });

  it('puts recent collaborators first, in the order given', () => {
    const { recent, others } = buildShareSuggestions(
      [alice, bob, carol],
      ['carol', 'alice'],
      new Set(),
    );

    expect(recent.map(u => u.id)).toEqual(['carol', 'alice']);
    expect(others.map(u => u.id)).toEqual(['bob']);
  });

  it('sorts the remaining users by display name, not username', () => {
    // Bob sorts under "Bob Smith", ahead of carol, despite the usernames.
    const { others } = buildShareSuggestions([carol, bob, alice], [], new Set());

    expect(others.map(u => u.id)).toEqual(['alice', 'bob', 'carol']);
  });

  it('excludes users in the excluded set from both groups', () => {
    const { recent, others } = buildShareSuggestions(
      [alice, bob, carol],
      ['alice'],
      new Set(['alice', 'bob']),
    );

    expect(recent).toEqual([]);
    expect(others.map(u => u.id)).toEqual(['carol']);
  });

  it('drops recent IDs that are no longer share candidates', () => {
    const { recent, others } = buildShareSuggestions([alice], ['deleted-user', 'alice'], new Set());

    expect(recent.map(u => u.id)).toEqual(['alice']);
    expect(others).toEqual([]);
  });

  it('returns empty groups for an empty candidate list', () => {
    expect(buildShareSuggestions([], ['alice'], new Set())).toEqual({ recent: [], others: [] });
  });
});
