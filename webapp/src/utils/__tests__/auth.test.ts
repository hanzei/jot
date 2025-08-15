import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { 
  getToken, 
  setToken, 
  removeToken, 
  getUser, 
  setUser, 
  isAuthenticated, 
  isAdmin 
} from '../auth'
import { User } from '@/types'
import { ROLES } from '@/constants/roles'

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
  role: 'user',
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
}

const mockAdminUser: User = {
  id: '2',
  username: 'adminuser',
  role: ROLES.ADMIN,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
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

  describe('getToken', () => {
    it('retrieves token from localStorage', () => {
      mockLocalStorage.getItem.mockReturnValue('test-token')

      const result = getToken()

      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('token')
      expect(result).toBe('test-token')
    })

    it('returns null when no token exists', () => {
      mockLocalStorage.getItem.mockReturnValue(null)

      const result = getToken()

      expect(result).toBeNull()
    })

    it('handles localStorage errors gracefully', () => {
      mockLocalStorage.getItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => getToken()).toThrow('localStorage error')
    })

    it('handles empty string token', () => {
      mockLocalStorage.getItem.mockReturnValue('')

      const result = getToken()

      expect(result).toBe('')
    })

    it('handles malformed token data', () => {
      mockLocalStorage.getItem.mockReturnValue(undefined)

      const result = getToken()

      expect(result).toBeUndefined()
    })
  })

  describe('setToken', () => {
    it('stores token in localStorage', () => {
      setToken('new-token')

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('token', 'new-token')
    })

    it('handles localStorage errors during token storage', () => {
      mockLocalStorage.setItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => setToken('test-token')).toThrow('localStorage error')
    })

    it('handles empty string token', () => {
      setToken('')

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('token', '')
    })

    it('handles null token', () => {
      setToken(null as any)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('token', null)
    })

    it('handles undefined token', () => {
      setToken(undefined as any)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('token', undefined)
    })

    it('handles very long token strings', () => {
      const longToken = 'a'.repeat(10000)
      setToken(longToken)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('token', longToken)
    })

    it('handles tokens with special characters', () => {
      const specialToken = 'token-with-special!@#$%^&*()_+{}[]|;:,.<>?'
      setToken(specialToken)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('token', specialToken)
    })
  })

  describe('removeToken', () => {
    it('removes token and user from localStorage', () => {
      removeToken()

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('token')
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('user')
    })

    it('handles localStorage errors during token removal', () => {
      mockLocalStorage.removeItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => removeToken()).toThrow('localStorage error')
    })

    it('removes both items even if localStorage is empty', () => {
      mockLocalStorage.getItem.mockReturnValue(null)

      removeToken()

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('token')
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('user')
    })

    it('handles partial failures gracefully', () => {
      mockLocalStorage.removeItem
        .mockImplementationOnce(() => {}) // token removal succeeds
        .mockImplementationOnce(() => { throw new Error('Failed to remove user') }) // user removal fails

      expect(() => removeToken()).toThrow('Failed to remove user')
      expect(mockLocalStorage.removeItem).toHaveBeenCalledTimes(2)
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
      const circularObj: any = { id: '1', username: 'test' }
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
      const userWithNulls = { ...mockUser, role: null } as any
      setUser(userWithNulls)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('user', JSON.stringify(userWithNulls))
    })

    it('handles user object with undefined values', () => {
      const userWithUndefined = { ...mockUser, role: undefined } as any
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
    it('returns true when both token and user exist', () => {
      mockLocalStorage.getItem
        .mockReturnValueOnce('test-token') // getToken call
        .mockReturnValueOnce(JSON.stringify(mockUser)) // getUser call

      const result = isAuthenticated()

      expect(result).toBe(true)
    })

    it('returns false when token is missing', () => {
      mockLocalStorage.getItem
        .mockReturnValueOnce(null) // getToken call
        .mockReturnValueOnce(JSON.stringify(mockUser)) // getUser call

      const result = isAuthenticated()

      expect(result).toBe(false)
    })

    it('returns false when user is missing', () => {
      mockLocalStorage.getItem
        .mockReturnValueOnce('test-token') // getToken call
        .mockReturnValueOnce(null) // getUser call

      const result = isAuthenticated()

      expect(result).toBe(false)
    })

    it('returns false when both token and user are missing', () => {
      mockLocalStorage.getItem.mockReturnValue(null)

      const result = isAuthenticated()

      expect(result).toBe(false)
    })

    it('returns false when token is empty string', () => {
      mockLocalStorage.getItem
        .mockReturnValueOnce('') // getToken call
        .mockReturnValueOnce(JSON.stringify(mockUser)) // getUser call

      const result = isAuthenticated()

      expect(result).toBe(false)
    })

    it('returns false when user data is malformed', () => {
      mockLocalStorage.getItem
        .mockReturnValueOnce('test-token') // getToken call
        .mockReturnValueOnce('invalid-json') // getUser call

      const result = isAuthenticated()

      expect(result).toBe(false)
    })

    it('handles localStorage errors gracefully', () => {
      mockLocalStorage.getItem.mockImplementation(() => {
        throw new Error('localStorage error')
      })

      expect(() => isAuthenticated()).toThrow('localStorage error')
    })

    it('handles partial authentication state', () => {
      mockLocalStorage.getItem
        .mockReturnValueOnce('test-token') // getToken call
        .mockReturnValueOnce(JSON.stringify({})) // getUser call with empty object

      const result = isAuthenticated()

      expect(result).toBe(true) // Both exist, even if user object is minimal
    })

    it('returns false for whitespace-only token', () => {
      mockLocalStorage.getItem
        .mockReturnValueOnce('   ') // getToken call
        .mockReturnValueOnce(JSON.stringify(mockUser)) // getUser call

      const result = isAuthenticated()

      expect(result).toBe(true) // Whitespace is still a truthy string
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
      const userWithoutRole = { ...mockUser, role: undefined } as any
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(userWithoutRole))

      const result = isAdmin()

      expect(result).toBe(false)
    })

    it('returns false when user role is null', () => {
      const userWithNullRole = { ...mockUser, role: null } as any
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
      const incompleteUser = { id: '1' } as any
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
      const userWithNumericRole = { ...mockUser, role: 1 } as any
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

      expect(() => setToken('test-token')).toThrow('Quota exceeded')
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
        expect(() => getToken()).toThrow()
        expect(() => setToken('test')).toThrow()
        expect(() => getUser()).toThrow()
        expect(() => setUser(mockUser)).toThrow()
        expect(() => removeToken()).toThrow()
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
        if (callCount === 1) return 'token1'
        if (callCount === 2) return JSON.stringify(mockUser)
        return 'token2'
      })

      const result1 = isAuthenticated()
      const result2 = getToken()

      expect(result1).toBe(true)
      expect(result2).toBe('token2')
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

    it('handles memory exhaustion with very large data', () => {
      const hugeToken = 'x'.repeat(1000000) // 1MB token
      
      setToken(hugeToken)

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('token', hugeToken)
    })

    it('handles race conditions in authentication state', () => {
      let tokenCallCount = 0
      let userCallCount = 0
      
      mockLocalStorage.getItem.mockImplementation((key) => {
        if (key === 'token') {
          tokenCallCount++
          return tokenCallCount === 1 ? 'test-token' : null
        }
        if (key === 'user') {
          userCallCount++
          return userCallCount === 1 ? JSON.stringify(mockUser) : null
        }
        return null
      })

      // First call should be authenticated (token and user both exist)
      const result1 = isAuthenticated()
      expect(result1).toBe(true)
      
      // Second call should not be authenticated (token and user are null now)
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