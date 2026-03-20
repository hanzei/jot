import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  CreateNoteRequest,
  UpdateNoteRequest,
  User,
  CreateUserRequest,
  ShareNoteRequest
} from '@jot/shared'

// Create mocked functions that will be hoisted
const mockPost = vi.hoisted(() => vi.fn())
const mockGet = vi.hoisted(() => vi.fn())
const mockPut = vi.hoisted(() => vi.fn())
const mockPatch = vi.hoisted(() => vi.fn())
const mockDelete = vi.hoisted(() => vi.fn())
const mockRequestUse = vi.hoisted(() => vi.fn())
const mockResponseUse = vi.hoisted(() => vi.fn())

// Mock axios completely
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      post: mockPost,
      get: mockGet,
      put: mockPut,
      patch: mockPatch,
      delete: mockDelete,
      interceptors: {
        request: { use: mockRequestUse },
        response: { use: mockResponseUse },
      },
    })),
  },
}))

// Import API module after mocking axios
import axios from 'axios'
import { auth, notes, users, admin } from '../api'
import { createMockNote } from './test-helpers'

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

// Mock location
const mockLocation = {
  href: '',
}
Object.defineProperty(window, 'location', {
  value: mockLocation,
  writable: true,
})


describe('API Module', () => {
  // Capture the response error handler before any vi.clearAllMocks() runs.
  let errorHandler: (error: unknown) => Promise<never>
  beforeAll(() => {
    errorHandler = mockResponseUse.mock.calls[0][1] as (error: unknown) => Promise<never>
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    mockLocation.href = ''
  })

  describe('API Instance Configuration', () => {
    it('axios.create mock is properly setup', () => {
      expect(axios.create).toBeDefined()
      expect(vi.isMockFunction(axios.create)).toBe(true)
    })

    it('mocked API functions are available', () => {
      expect(auth.login).toBeDefined()
      expect(auth.register).toBeDefined()
      expect(notes.getAll).toBeDefined()
      expect(notes.create).toBeDefined()
      expect(notes.update).toBeDefined()
      expect(notes.delete).toBeDefined()
      expect(users.search).toBeDefined()
      expect(admin.getUsers).toBeDefined()
      expect(admin.createUser).toBeDefined()
    })
  })

  describe('Response Interceptor', () => {

    it('clears user and redirects to login on 401 error', async () => {
      const error401 = { response: { status: 401 } }
      await expect(errorHandler(error401)).rejects.toEqual(error401)

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('user')
      expect(mockLocation.href).toBe('/login')
    })

    it('does not redirect on 401 from /me endpoint', async () => {
      const error401 = { response: { status: 401 }, config: { url: '/me' } }
      await expect(errorHandler(error401)).rejects.toEqual(error401)

      expect(mockLocalStorage.removeItem).not.toHaveBeenCalled()
      expect(mockLocation.href).not.toBe('/login')
    })

    it('does not redirect for non-401 errors', async () => {
      const error500 = { response: { status: 500 } }
      await expect(errorHandler(error500)).rejects.toEqual(error500)

      expect(mockLocation.href).not.toBe('/login')
    })

    it('does not redirect for network errors without response', async () => {
      const networkError = new Error('Network error')
      await expect(errorHandler(networkError)).rejects.toEqual(networkError)

      expect(mockLocation.href).not.toBe('/login')
    })
  })

  describe('Auth API', () => {
    describe('login', () => {
      it('makes POST request to /login with credentials', async () => {
        const mockResponse: AuthResponse = {
          user: {
            id: '1',
            username: 'testuser',
            first_name: '',
            last_name: '',
            role: 'user',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
            has_profile_icon: false,
          },
          settings: { user_id: '1', language: 'system', theme: 'system', updated_at: '2023-01-01T00:00:00Z' },
        }
        mockPost.mockResolvedValue({ data: mockResponse })

        const credentials: LoginRequest = {
          username: 'testuser',
          password: 'password123'
        }

        const result = await auth.login(credentials)

        expect(mockPost).toHaveBeenCalledWith('/login', credentials)
        expect(result).toEqual(mockResponse)
      })

      it('handles login failure', async () => {
        const error = new Error('Invalid credentials')
        mockPost.mockRejectedValue(error)

        const credentials: LoginRequest = {
          username: 'invalid',
          password: 'wrong'
        }

        await expect(auth.login(credentials)).rejects.toThrow('Invalid credentials')
      })

      it('handles network errors during login', async () => {
        const networkError = new Error('Network timeout')
        mockPost.mockRejectedValue(networkError)

        const credentials: LoginRequest = {
          username: 'testuser',
          password: 'password123'
        }

        await expect(auth.login(credentials)).rejects.toThrow('Network timeout')
      })

      it('handles malformed login response', async () => {
        mockPost.mockResolvedValue({ data: null })

        const credentials: LoginRequest = {
          username: 'testuser',
          password: 'password123'
        }

        const result = await auth.login(credentials)
        expect(result).toBeNull()
      })
    })

    describe('register', () => {
      it('makes POST request to /register with user data', async () => {
        const mockResponse: AuthResponse = {
          user: {
            id: '1',
            username: 'newuser',
            first_name: '',
            last_name: '',
            role: 'user',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
            has_profile_icon: false,
          },
          settings: { user_id: '1', language: 'system', theme: 'system', updated_at: '2023-01-01T00:00:00Z' },
        }
        mockPost.mockResolvedValue({ data: mockResponse })

        const registerData: RegisterRequest = {
          username: 'newuser',
          password: 'password123'
        }

        const result = await auth.register(registerData)

        expect(mockPost).toHaveBeenCalledWith('/register', registerData)
        expect(result).toEqual(mockResponse)
      })

      it('handles registration with existing username', async () => {
        const error = new Error('Username already exists')
        mockPost.mockRejectedValue(error)

        const registerData: RegisterRequest = {
          username: 'existinguser',
          password: 'password123'
        }

        await expect(auth.register(registerData)).rejects.toThrow('Username already exists')
      })

      it('handles weak password errors', async () => {
        const error = new Error('Password too weak')
        mockPost.mockRejectedValue(error)

        const registerData: RegisterRequest = {
          username: 'newuser',
          password: '123'
        }

        await expect(auth.register(registerData)).rejects.toThrow('Password too weak')
      })
    })
  })

  describe('Notes API', () => {
    const mockNote = createMockNote()

    describe('getAll', () => {
      it('fetches all notes with default parameters', async () => {
        const mockNotes = [mockNote]
        mockGet.mockResolvedValue({ data: mockNotes })

        const result = await notes.getAll()

        expect(mockGet).toHaveBeenCalledWith('/notes', { 
          params: { archived: false, search: '', trashed: false }
        })
        expect(result).toEqual(mockNotes)
      })

      it('fetches archived notes when requested', async () => {
        const mockNotes = [{ ...mockNote, archived: true }]
        mockGet.mockResolvedValue({ data: mockNotes })

        const result = await notes.getAll(true)

        expect(mockGet).toHaveBeenCalledWith('/notes', { 
          params: { archived: true, search: '', trashed: false }
        })
        expect(result).toEqual(mockNotes)
      })

      it('includes search query when provided', async () => {
        const mockNotes = [mockNote]
        mockGet.mockResolvedValue({ data: mockNotes })

        const result = await notes.getAll(false, 'test query')

        expect(mockGet).toHaveBeenCalledWith('/notes', { 
          params: { archived: false, search: 'test query', trashed: false }
        })
        expect(result).toEqual(mockNotes)
      })

      it('handles empty response', async () => {
        mockGet.mockResolvedValue({ data: [] })

        const result = await notes.getAll()

        expect(result).toEqual([])
      })

      it('handles API errors', async () => {
        const error = new Error('Server error')
        mockGet.mockRejectedValue(error)

        await expect(notes.getAll()).rejects.toThrow('Server error')
      })

      it('handles malformed response data', async () => {
        mockGet.mockResolvedValue({ data: null })

        const result = await notes.getAll()
        expect(result).toBeNull()
      })

      it('handles special characters in search query', async () => {
        const specialQuery = '<script>alert("xss")</script>'
        mockGet.mockResolvedValue({ data: [] })

        await notes.getAll(false, specialQuery)

        expect(mockGet).toHaveBeenCalledWith('/notes', { 
          params: { archived: false, search: specialQuery, trashed: false }
        })
      })
    })

    describe('getById', () => {
      it('fetches single note by ID', async () => {
        mockGet.mockResolvedValue({ data: mockNote })

        const result = await notes.getById('1')

        expect(mockGet).toHaveBeenCalledWith('/notes/1')
        expect(result).toEqual(mockNote)
      })

      it('handles non-existent note ID', async () => {
        const error = new Error('Note not found')
        mockGet.mockRejectedValue(error)

        await expect(notes.getById('999')).rejects.toThrow('Note not found')
      })

      it('handles malformed note ID', async () => {
        mockGet.mockResolvedValue({ data: mockNote })

        const result = await notes.getById('invalid-id')

        expect(mockGet).toHaveBeenCalledWith('/notes/invalid-id')
        expect(result).toEqual(mockNote)
      })
    })

    describe('create', () => {
      it('creates new text note', async () => {
        const newNote: CreateNoteRequest = {
          title: 'New Note',
          content: 'New content',
          note_type: 'text',
          color: '#ffffff'
        }
        mockPost.mockResolvedValue({ data: mockNote })

        const result = await notes.create(newNote)

        expect(mockPost).toHaveBeenCalledWith('/notes', newNote)
        expect(result).toEqual(mockNote)
      })

      it('creates new todo note with items', async () => {
        const todoNote: CreateNoteRequest = {
          title: 'Todo Note',
          content: '',
          note_type: 'todo',
          items: [
            { text: 'First task', position: 0 },
            { text: 'Second task', position: 1 }
          ]
        }
        const mockTodoNote = { ...mockNote, note_type: 'todo' as const }
        mockPost.mockResolvedValue({ data: mockTodoNote })

        const result = await notes.create(todoNote)

        expect(mockPost).toHaveBeenCalledWith('/notes', todoNote)
        expect(result).toEqual(mockTodoNote)
      })

      it('handles creation with invalid data', async () => {
        const error = new Error('Invalid note data')
        mockPost.mockRejectedValue(error)

        const invalidNote: CreateNoteRequest = {
          title: '',
          content: '',
          note_type: 'text'
        }

        await expect(notes.create(invalidNote)).rejects.toThrow('Invalid note data')
      })

      it('handles network errors during creation', async () => {
        const networkError = new Error('Network timeout')
        mockPost.mockRejectedValue(networkError)

        const newNote: CreateNoteRequest = {
          title: 'New Note',
          content: 'New content',
          note_type: 'text'
        }

        await expect(notes.create(newNote)).rejects.toThrow('Network timeout')
      })
    })

    describe('update', () => {
      it('updates existing note', async () => {
        const updateData: UpdateNoteRequest = {
          title: 'Updated Note',
          content: 'Updated content',
          pinned: true,
          archived: false,
          color: '#fbbc04',
          checked_items_collapsed: false
        }
        const updatedNote = { ...mockNote, ...updateData }
        mockPatch.mockResolvedValue({ data: updatedNote })

        const result = await notes.update('1', updateData)

        expect(mockPatch).toHaveBeenCalledWith('/notes/1', updateData)
        expect(result).toEqual(updatedNote)
      })

      it('handles update of non-existent note', async () => {
        const error = new Error('Note not found')
        mockPatch.mockRejectedValue(error)

        const updateData: UpdateNoteRequest = {
          title: 'Updated Note',
          content: 'Updated content',
          pinned: false,
          archived: false,
          color: '#ffffff',
          checked_items_collapsed: false
        }

        await expect(notes.update('999', updateData)).rejects.toThrow('Note not found')
      })

      it('handles concurrent updates', async () => {
        const updateData: UpdateNoteRequest = {
          title: 'Updated Note',
          content: 'Updated content',
          pinned: false,
          archived: false,
          color: '#ffffff',
          checked_items_collapsed: false
        }
        const updatedNote = { ...mockNote, ...updateData }
        mockPatch.mockResolvedValue({ data: updatedNote })

        // Simulate concurrent updates
        const promise1 = notes.update('1', updateData)
        const promise2 = notes.update('1', { ...updateData, title: 'Different Title' })

        const [result1, result2] = await Promise.all([promise1, promise2])

        expect(mockPatch).toHaveBeenCalledTimes(2)
        expect(result1).toEqual(updatedNote)
        expect(result2).toEqual(updatedNote)
      })
    })

    describe('delete', () => {
      it('deletes note by ID', async () => {
        mockDelete.mockResolvedValue({})

        await notes.delete('1')

        expect(mockDelete).toHaveBeenCalledWith('/notes/1')
      })

      it('handles deletion of non-existent note', async () => {
        const error = new Error('Note not found')
        mockDelete.mockRejectedValue(error)

        await expect(notes.delete('999')).rejects.toThrow('Note not found')
      })

      it('handles network errors during deletion', async () => {
        const networkError = new Error('Network timeout')
        mockDelete.mockRejectedValue(networkError)

        await expect(notes.delete('1')).rejects.toThrow('Network timeout')
      })

      it('empties trash and returns deleted count', async () => {
        const response = { deleted: 3 }
        mockDelete.mockResolvedValue({ data: response })

        const result = await notes.emptyTrash()

        expect(mockDelete).toHaveBeenCalledWith('/notes/trash')
        expect(result).toEqual(response)
      })
    })

    describe('sharing functionality', () => {
      it('shares note with user', async () => {
        const shareData: ShareNoteRequest = { user_id: 'abcdefghijklmnopqrstuv' }
        const shareResponse = { success: true, message: 'Note shared' }
        mockPost.mockResolvedValue({ data: shareResponse })

        const result = await notes.share('1', shareData)

        expect(mockPost).toHaveBeenCalledWith('/notes/1/share', shareData)
        expect(result).toEqual(shareResponse)
      })

      it('unshares note', async () => {
        const unshareData: ShareNoteRequest = { user_id: 'abcdefghijklmnopqrstuv' }
        const unshareResponse = { success: true, message: 'Note unshared' }
        mockDelete.mockResolvedValue({ data: unshareResponse })

        const result = await notes.unshare('1', unshareData)

        expect(mockDelete).toHaveBeenCalledWith('/notes/1/share', { data: unshareData })
        expect(result).toEqual(unshareResponse)
      })

      it('gets note shares', async () => {
        const shares = [
          {
            id: '1',
            note_id: '1',
            shared_with_user_id: 'user2',
            shared_by_user_id: 'user1',
            permission_level: 'read',
            username: 'testuser',
            first_name: '',
            last_name: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          }
        ]
        mockGet.mockResolvedValue({ data: shares })

        const result = await notes.getShares('1')

        expect(mockGet).toHaveBeenCalledWith('/notes/1/shares')
        expect(result).toEqual(shares)
      })

      it('handles sharing errors', async () => {
        const error = new Error('User not found')
        mockPost.mockRejectedValue(error)

        const shareData: ShareNoteRequest = { user_id: 'abcdefghijklmnopqrstuv' }

        await expect(notes.share('1', shareData)).rejects.toThrow('User not found')
      })
    })

    describe('reorder', () => {
      it('reorders notes successfully', async () => {
        const noteIds = ['3', '1', '2']
        mockPost.mockResolvedValue({})

        await notes.reorder(noteIds)

        expect(mockPost).toHaveBeenCalledWith('/notes/reorder', { 
          note_ids: noteIds 
        })
      })

      it('handles empty note IDs array', async () => {
        mockPost.mockResolvedValue({})

        await notes.reorder([])

        expect(mockPost).toHaveBeenCalledWith('/notes/reorder', { 
          note_ids: [] 
        })
      })

      it('handles reorder with invalid note IDs', async () => {
        const error = new Error('Invalid note IDs')
        mockPost.mockRejectedValue(error)

        const invalidIds = ['invalid', '999']

        await expect(notes.reorder(invalidIds)).rejects.toThrow('Invalid note IDs')
      })
    })
  })

  describe('Users API', () => {
    describe('search', () => {
      it('searches all users', async () => {
        const mockUsers: User[] = [
          {
            id: '1',
            username: 'user1',
            first_name: '',
            last_name: '',
            role: 'user',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
            has_profile_icon: false,
          }
        ]
        mockGet.mockResolvedValue({ data: mockUsers })

        const result = await users.search()

        expect(mockGet).toHaveBeenCalledWith('/users')
        expect(result).toEqual(mockUsers)
      })

      it('handles empty users response', async () => {
        mockGet.mockResolvedValue({ data: [] })

        const result = await users.search()

        expect(result).toEqual([])
      })

      it('handles users API errors', async () => {
        const error = new Error('Unauthorized')
        mockGet.mockRejectedValue(error)

        await expect(users.search()).rejects.toThrow('Unauthorized')
      })
    })
  })

  describe('Admin API', () => {
    describe('getUsers', () => {
      it('gets all users for admin', async () => {
        const mockResponse = {
          users: [
            {
              id: '1',
              username: 'user1',
              first_name: '',
              last_name: '',
              role: 'user',
              created_at: '2023-01-01T00:00:00Z',
              updated_at: '2023-01-01T00:00:00Z',
              has_profile_icon: false,
            }
          ]
        }
        mockGet.mockResolvedValue({ data: mockResponse })

        const result = await admin.getUsers()

        expect(mockGet).toHaveBeenCalledWith('/admin/users')
        expect(result).toEqual(mockResponse)
      })

      it('handles admin access denied', async () => {
        const error = new Error('Access denied')
        mockGet.mockRejectedValue(error)

        await expect(admin.getUsers()).rejects.toThrow('Access denied')
      })
    })

    describe('createUser', () => {
      it('creates new user as admin', async () => {
        const newUser: CreateUserRequest = {
          username: 'newuser',
          password: 'password123',
          role: 'user'
        }
        const createdUser: User = {
          id: '2',
          username: 'newuser',
          first_name: '',
          last_name: '',
          role: 'user',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
          has_profile_icon: false,
        }
        mockPost.mockResolvedValue({ data: createdUser })

        const result = await admin.createUser(newUser)

        expect(mockPost).toHaveBeenCalledWith('/admin/users', newUser)
        expect(result).toEqual(createdUser)
      })

      it('handles user creation failure', async () => {
        const error = new Error('Username already exists')
        mockPost.mockRejectedValue(error)

        const newUser: CreateUserRequest = {
          username: 'existinguser',
          password: 'password123',
          role: 'user'
        }

        await expect(admin.createUser(newUser)).rejects.toThrow('Username already exists')
      })

      it('handles invalid role assignment', async () => {
        const error = new Error('Invalid role')
        mockPost.mockRejectedValue(error)

        const newUser: CreateUserRequest = {
          username: 'newuser',
          password: 'password123',
          role: 'invalidrole'
        }

        await expect(admin.createUser(newUser)).rejects.toThrow('Invalid role')
      })
    })
  })

  describe('Edge Cases and Error Scenarios', () => {
    it('validates API module exports are available', () => {
      // Test that our API module exports are properly mocked and available
      expect(typeof auth.login).toBe('function')
      expect(typeof auth.register).toBe('function')
      expect(typeof notes.getAll).toBe('function')
      expect(typeof users.search).toBe('function')
      expect(typeof admin.getUsers).toBe('function')
    })

    it('handles localStorage errors gracefully in user retrieval', () => {
      // Test localStorage error handling separately from interceptors
      const getUserSafely = () => {
        try {
          return localStorage.getItem('user')
        } catch {
          return null
        }
      }

      // Mock localStorage to throw an error
      const originalGetItem = mockLocalStorage.getItem
      mockLocalStorage.getItem.mockImplementationOnce(() => {
        throw new Error('localStorage error')
      })

      const user = getUserSafely()
      expect(user).toBeNull()

      // Restore mock
      mockLocalStorage.getItem = originalGetItem
    })

    it('handles concurrent API calls', async () => {
      const sampleNote = createMockNote()
      const mockNotes = [sampleNote]
      mockGet.mockResolvedValue({ data: mockNotes })

      // Make concurrent calls
      const promises = [
        notes.getAll(),
        notes.getAll(true),
        notes.getAll(false, 'search'),
        notes.getById('1'),
      ]

      const results = await Promise.all(promises)

      expect(results).toHaveLength(4)
      expect(mockGet).toHaveBeenCalledTimes(4)
    })

    it('passes null/undefined parameters through to axios without throwing', async () => {
      const sampleNote = createMockNote()
      mockGet.mockResolvedValue({ data: [] })
      mockPost.mockResolvedValue({ data: sampleNote })
      mockPatch.mockResolvedValue({ data: sampleNote })

      // Verifies that the API wrappers do not add their own null-checks and pass
      // the values straight to axios (mocked here). Input validation is the
      // caller's responsibility.
      await notes.getAll(undefined as unknown as boolean, null as unknown as string)
      await notes.create(null as unknown as CreateNoteRequest)
      await notes.update(undefined as unknown as string, null as unknown as UpdateNoteRequest)

      expect(mockGet).toHaveBeenCalled()
      expect(mockPost).toHaveBeenCalled()
      expect(mockPatch).toHaveBeenCalled()
    })
  })
})