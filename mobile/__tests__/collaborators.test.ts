import { buildCollaborators, displayName, Collaborator } from '../src/utils/collaborators';
import { NoteShare } from '../src/types';

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
    it('returns owner as first collaborator', () => {
      const result = buildCollaborators('owner-id', [], 'owneruser');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ userId: 'owner-id', username: 'owneruser', hasProfileIcon: undefined });
    });

    it('returns owner with profile icon when provided', () => {
      const result = buildCollaborators('owner-id', [], 'owneruser', true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ userId: 'owner-id', username: 'owneruser', hasProfileIcon: true });
    });

    it('includes shared users', () => {
      const shares: NoteShare[] = [
        {
          id: 's1',
          note_id: 'n1',
          shared_with_user_id: 'user-2',
          shared_by_user_id: 'owner-id',
          permission_level: 'edit',
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Smith',
          has_profile_icon: true,
          created_at: '',
          updated_at: '',
        },
      ];
      const result = buildCollaborators('owner-id', shares, 'owneruser');
      expect(result).toHaveLength(2);
      expect(result[1]).toEqual({
        userId: 'user-2',
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Smith',
        hasProfileIcon: true,
      });
    });

    it('deduplicates owner from shared list', () => {
      const shares: NoteShare[] = [
        {
          id: 's1',
          note_id: 'n1',
          shared_with_user_id: 'owner-id',
          shared_by_user_id: 'owner-id',
          permission_level: 'edit',
          username: 'owneruser',
          created_at: '',
          updated_at: '',
        },
      ];
      const result = buildCollaborators('owner-id', shares, 'owneruser');
      expect(result).toHaveLength(1);
    });

    it('returns empty owner username when not provided', () => {
      const result = buildCollaborators('owner-id', undefined);
      expect(result[0].username).toBe('?');
    });
  });
});
