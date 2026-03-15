import { buildCollaborators, displayName, Collaborator } from '../src/utils/collaborators';
import { NoteShare, User } from '../src/types';

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

describe('collaborators', () => {
  describe('displayName', () => {
    it('returns full name when both first and last names are present', () => {
      const c: Collaborator = { userId: 'u1', username: 'john', firstName: 'John', lastName: 'Doe' };
      expect(displayName(c)).toBe('John Doe');
    });

    it('returns first name only when last name is absent', () => {
      const c: Collaborator = { userId: 'u1', username: 'john', firstName: 'John' };
      expect(displayName(c)).toBe('John');
    });

    it('falls back to username when no names provided', () => {
      const c: Collaborator = { userId: 'u1', username: 'john' };
      expect(displayName(c)).toBe('john');
    });
  });

  describe('buildCollaborators', () => {
    it('returns owner as first collaborator from usersById', () => {
      const usersById = new Map<string, User>();
      usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'owneruser', has_profile_icon: true }));
      const result = buildCollaborators('owner-id', [], usersById);
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('owner-id');
      expect(result[0].username).toBe('owneruser');
      expect(result[0].hasProfileIcon).toBe(true);
    });

    it('includes shared users with usersById data taking precedence', () => {
      const shares: NoteShare[] = [
        {
          id: 's1', note_id: 'n1', shared_with_user_id: 'user-2', shared_by_user_id: 'owner-id',
          permission_level: 'edit', username: 'alice_old', first_name: 'OldAlice',
          created_at: '', updated_at: '',
        },
      ];
      const usersById = new Map<string, User>();
      usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'owneruser' }));
      usersById.set('user-2', makeUser({ id: 'user-2', username: 'alice', first_name: 'Alice', last_name: 'Smith' }));
      const result = buildCollaborators('owner-id', shares, usersById);
      expect(result).toHaveLength(2);
      expect(result[1].username).toBe('alice');
      expect(result[1].firstName).toBe('Alice');
      expect(result[1].lastName).toBe('Smith');
    });

    it('falls back to share data when user not in usersById', () => {
      const shares: NoteShare[] = [
        {
          id: 's1', note_id: 'n1', shared_with_user_id: 'user-2', shared_by_user_id: 'owner-id',
          permission_level: 'edit', username: 'alice', first_name: 'Alice',
          created_at: '', updated_at: '',
        },
      ];
      const usersById = new Map<string, User>();
      usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'owneruser' }));
      const result = buildCollaborators('owner-id', shares, usersById);
      expect(result).toHaveLength(2);
      expect(result[1].username).toBe('alice');
      expect(result[1].firstName).toBe('Alice');
    });

    it('deduplicates owner from shared list', () => {
      const shares: NoteShare[] = [
        {
          id: 's1', note_id: 'n1', shared_with_user_id: 'owner-id', shared_by_user_id: 'owner-id',
          permission_level: 'edit', username: 'owneruser', created_at: '', updated_at: '',
        },
      ];
      const usersById = new Map<string, User>();
      usersById.set('owner-id', makeUser({ id: 'owner-id', username: 'owneruser' }));
      const result = buildCollaborators('owner-id', shares, usersById);
      expect(result).toHaveLength(1);
    });

    it('returns ? username when owner not in usersById', () => {
      const result = buildCollaborators('owner-id', undefined, new Map());
      expect(result[0].username).toBe('?');
    });
  });
});
