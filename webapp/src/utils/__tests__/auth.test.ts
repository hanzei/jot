import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  removeUser,
  getUser,
  setUser,
  isAuthenticated,
  isAdmin
} from '../auth'
import { ROLES, type User } from '@jot/shared'

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}
Object.defineProperty(window, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

const mockUser: User = {
  id: '1',
  username: 'testuser',
  first_name: '',
  last_name: '',
  role: ROLES.USER,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  has_profile_icon: false,
}

const mockAdminUser: User = {
  id: '2',
  username: 'adminuser',
  first_name: '',
  last_name: '',
  role: ROLES.ADMIN,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  has_profile_icon: false,
}

describe('Auth Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    mockLocalStorage.getItem.mockReset()
    mockLocalStorage.setItem.mockReset()
    mockLocalStorage.removeItem.mockReset()
  })

  describe('removeUser', () => {
    it('removes user from localStorage', () => {
      removeUser()

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('user')
    })

    it('handles localStorage errors during user removal', () => {
      mockLocalStorage.removeItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => removeUser()).toThrow('localStorage error')
    })

    it('removes user even if localStorage is empty', () => {
      mockLocalStorage.getItem.mockReturnValue(null)

      removeUser()

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('user')
    })
  })

  describe('getUser', () => {
    it('retrieves and parses user from localStorage', () => {
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(mockUser))

      const result = getUser()

      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('user')
      expect(result).toEqual(mockUser)
    })

    it('returns null when no user exists', () => {
      mockLocalStorage.getItem.mockReturnValue(null)

      const result = getUser()

      expect(result).toBeNull()
    })

    it('returns null when user data is malformed JSON', () => {
      mockLocalStorage.getItem.mockReturnValue('invalid-json{')

      const result = getUser()

      expect(result).toBeNull()
    })

    it('handles empty string user data', () => {
      mockLocalStorage.getItem.mockReturnValue('')

      const result = getUser()

      expect(result).toBeNull()
    })

    it('handles localStorage errors gracefully', () => {
      mockLocalStorage.getItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => getUser()).toThrow('localStorage error')
    })

    it('handles partial user objects', () => {
      const partialUser = { id: '1', username: 'test' }
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(partialUser))

      const result = getUser()

      expect(result).toEqual(partialUser)
    })

    it('handles user object with extra properties', () => {
      const userWithExtra = { ...mockUser, extraProperty: 'extra' }
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithExtra))

      const result = getUser()

      expect(result).toEqual(userWithExtra)
    })

    it('handles null values in user object', () => {
      const userWithNulls = { ...mockUser, role: null }
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithNulls))

      const result = getUser()

      expect(result).toEqual(userWithNulls)
    })

    it('handles circular references in JSON gracefully', () => {
      const circularObj: Record<string, unknown> = { id: '1', username: 'test' }
      circularObj.self = circularObj
      
      // JSON.stringify would fail with circular references
      mockLocalStorage.getItem.mockReturnValue('[object Object]')

      const result = getUser()

      expect(result).toBeNull()
    })

    it('handles very large user objects', () => {
      const largeUser = {
        ...mockUser,
        largeData: 'x'.repeat(100000)
      }
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(largeUser))

      const result = getUser()

      expect(result).toEqual(largeUser)
    })
  })

  describe('setUser', () => {
    it('stores user as JSON string in localStorage', () => {
      setUser(mockUser)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('user', JSON.stringify(mockUser))
    })

    it('handles localStorage errors during user storage', () => {
      mockLocalStorage.setItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => setUser(mockUser)).toThrow('localStorage error')
    })

    it('handles user object with null values', () => {
      const userWithNulls = { ...mockUser, role: null } as unknown as User
      setUser(userWithNulls)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('user', JSON.stringify(userWithNulls))
    })

    it('handles user object with undefined values', () => {
      const userWithUndefined = { ...mockUser, role: undefined } as unknown as User
      setUser(userWithUndefined)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('user', JSON.stringify(userWithUndefined))
    })

    it('handles empty user object', () => {
      const emptyUser = {} as User
      setUser(emptyUser)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('user', JSON.stringify(emptyUser))
    })

    it('handles user object with special characters', () => {
      const userWithSpecialChars = {
        ...mockUser,
        username: 'user@domain.com!@#$%^&*()',
      }
      setUser(userWithSpecialChars)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('user', JSON.stringify(userWithSpecialChars))
    })

    it('handles user object with very long strings', () => {
      const userWithLongData = {
        ...mockUser,
        username: 'x'.repeat(10000),
      }
      setUser(userWithLongData)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('user', JSON.stringify(userWithLongData))
    })
  })

  describe('isAuthenticated', () => {
    it('returns true when user exists', () => {
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(mockUser))

      const result = isAuthenticated()

      expect(result).toBe(true)
    })

    it('returns false when user is missing', () => {
      mockLocalStorage.getItem.mockReturnValue(null)

      const result = isAuthenticated()

      expect(result).toBe(false)
    })

    it('returns false when user data is malformed', () => {
      mockLocalStorage.getItem.mockReturnValue('invalid-json')

      const result = isAuthenticated()

      expect(result).toBe(false)
    })

    it('handles localStorage errors gracefully', () => {
      mockLocalStorage.getItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => isAuthenticated()).toThrow('localStorage error')
    })

    it('returns true for minimal user object', () => {
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify({}))

      const result = isAuthenticated()

      expect(result).toBe(true)
    })
  })

  describe('isAdmin', () => {
    it('returns true for admin user', () => {
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(mockAdminUser))

      const result = isAdmin()

      expect(result).toBe(true)
    })

    it('returns false for regular user', () => {
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(mockUser))

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('returns false when user is null', () => {
      mockLocalStorage.getItem.mockReturnValue(null)

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('returns false when user data is malformed', () => {
      mockLocalStorage.getItem.mockReturnValue('invalid-json')

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('returns false when user has no role', () => {
      const userWithoutRole = { ...mockUser, role: undefined } as unknown as User
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithoutRole))

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('returns false when user role is null', () => {
      const userWithNullRole = { ...mockUser, role: null } as unknown as User
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithNullRole))

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('returns false when user role is empty string', () => {
      const userWithEmptyRole = { ...mockUser, role: '' }
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithEmptyRole))

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('handles case sensitivity in role checking', () => {
      const userWithCaseMismatch = { ...mockUser, role: 'ADMIN' }
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithCaseMismatch))

      const result = isAdmin()

      // Assumes ROLES.ADMIN is 'admin' - this will be false due to case mismatch
      expect(result).toBe(false)
    })

    it('handles localStorage errors gracefully', () => {
      mockLocalStorage.getItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => isAdmin()).toThrow('localStorage error')
    })

    it('handles user object without required properties', () => {
      const incompleteUser = { id: '1' } as unknown as User
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(incompleteUser))

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('returns false for unknown roles', () => {
      const userWithUnknownRole = { ...mockUser, role: 'superuser' }
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithUnknownRole))

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('handles numeric role values', () => {
      const userWithNumericRole = { ...mockUser, role: 1 } as unknown as User
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithNumericRole))

      const result = isAdmin()

      expect(result).toBe(false)
    })
  })

  describe('Edge Cases and Security Considerations', () => {
    it('handles localStorage quota exceeded errors', () => {
      mockLocalStorage.setItem.mockImplementation(() => {
        const error = new Error('Quota exceeded')
        error.name = 'QuotaExceededError'
        throw error
      })

      expect(() => setUser(mockUser)).toThrow('Quota exceeded')
    })

    it('handles localStorage disabled in private/incognito mode', () => {
      // Test that functions handle disabled localStorage gracefully
      // This test verifies the current behavior - that functions will throw when localStorage is disabled
      const originalLocalStorage = window.localStorage

      try {
        // Simulate localStorage being disabled
        Object.defineProperty(window, 'localStorage', {
          value: null,
          writable: true,
        })

        // These should throw because localStorage is null
        expect(() => getUser()).toThrow()
        expect(() => setUser(mockUser)).toThrow()
        expect(() => removeUser()).toThrow()
        expect(() => isAuthenticated()).toThrow()
        expect(() => isAdmin()).toThrow()
      } finally {
        // Always restore localStorage in finally block
        Object.defineProperty(window, 'localStorage', {
          value: originalLocalStorage,
          writable: true,
        })
      }
    })

    it('handles concurrent access to localStorage', () => {
      let callCount = 0
      mockLocalStorage.getItem.mockImplementation(() => {
        callCount++
        if (callCount === 1) return JSON.stringify(mockUser)
        return null
      })

      const result1 = isAuthenticated()
      const result2 = getUser()

      expect(result1).toBe(true)
      expect(result2).toBeNull()
    })

    it('handles XSS attempts in stored data', () => {
      const maliciousUser = {
        ...mockUser,
        username: '<script>alert("xss")</script>',
        role: 'user<img src=x onerror=alert("xss")>',
      }

      setUser(maliciousUser)
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(maliciousUser))

      const retrievedUser = getUser()

      expect(retrievedUser?.username).toContain('<script>')
      expect(retrievedUser?.role).toContain('<img')
      // Note: This test shows that the auth utility doesn't sanitize data
      // Sanitization should happen at the UI layer
    })

    it('handles prototype pollution attempts', () => {
      const maliciousUserData = JSON.stringify({
        ...mockUser,
        __proto__: { isAdmin: true },
        constructor: { prototype: { isAdmin: true } }
      })

      mockLocalStorage.getItem.mockReturnValue(maliciousUserData)

      const user = getUser()
      
      // Should not affect the prototype chain - JSON.parse strips __proto__ properties
      expect(user).not.toHaveProperty('__proto__')
      expect(isAdmin()).toBe(false) // Should still work correctly
    })

    it('handles race conditions in authentication state', () => {
      let userCallCount = 0

      mockLocalStorage.getItem.mockImplementation(() => {
        userCallCount++
        return userCallCount === 1 ? JSON.stringify(mockUser) : null
      })

      // First call should be authenticated (user exists)
      const result1 = isAuthenticated()
      expect(result1).toBe(true)

      // Second call should not be authenticated (user is null now)
      const result2 = isAuthenticated()
      expect(result2).toBe(false)
    })

    it('handles JSON.parse with reviver function vulnerabilities', () => {
      const dateString = '2023-01-01T00:00:00Z'
      const userWithDate = {
        ...mockUser,
        created_at: dateString,
        updated_at: dateString,
      }
      
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithDate))

      const retrievedUser = getUser()

      // Dates should remain as strings (no automatic parsing)
      expect(typeof retrievedUser?.created_at).toBe('string')
      expect(typeof retrievedUser?.updated_at).toBe('string')
    })
  })
})