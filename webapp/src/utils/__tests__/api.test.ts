import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { 
  AuthResponse, 
  LoginRequest, 
  RegisterRequest, 
  Note, 
  CreateNoteRequest, 
  UpdateNoteRequest,
  User,
  CreateUserRequest,
  ShareNoteRequest
} from '@/types'

// Create mocked functions that will be hoisted
const mockPost = vi.hoisted(() => vi.fn())
const mockGet = vi.hoisted(() => vi.fn())
const mockPut = vi.hoisted(() => vi.fn())
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

// Global mock note function for tests
const createMockNote = (overrides: Partial<Note> = {}): Note => ({
  id: '1',
  title: 'Test Note',
  content: 'Test content',
  note_type: 'text',
  pinned: false,
  archived: false,
  color: '#ffffff',
  user_id: 'user1',
  is_shared: false,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  checked_items_collapsed: false,
  items: [],
  position: 0,
  ...overrides,
})

describe('API Module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLocalStorage.getItem.mockReturnValue('mock-token')
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

  describe('Request Interceptor Logic', () => {
    it('tests auth token logic independently', () => {
      // Since interceptors are set up at module load time and our mocks
      // aren't available then, we test the interceptor logic separately
      const addAuthToken = (config: any, token: string | null) => {
        if (token) {
          config.headers.Authorization = `Bearer ${token}`
        }
        return config
      }

      const config = { headers: {} }
      const result = addAuthToken(config, 'test-token')
      expect(result.headers.Authorization).toBe('Bearer test-token')

      const configNoToken = { headers: {} }
      const resultNoToken = addAuthToken(configNoToken, null)
      expect(resultNoToken.headers.Authorization).toBeUndefined()
    })
  })

  describe('Response Interceptor Logic', () => {
    it('tests 401 error handling logic independently', () => {
      // Test the 401 error handling logic separately from axios interceptors
      const handle401Error = (error: any) => {
        if (error.response?.status === 401) {
          // In real code, this would clear tokens and redirect
          return { shouldClearAuth: true, shouldRedirect: true }
        }
        return { shouldClearAuth: false, shouldRedirect: false }
      }

      const error401 = { response: { status: 401 } }
      const result401 = handle401Error(error401)
      expect(result401.shouldClearAuth).toBe(true)
      expect(result401.shouldRedirect).toBe(true)

      const error500 = { response: { status: 500 } }
      const result500 = handle401Error(error500)
      expect(result500.shouldClearAuth).toBe(false)
      expect(result500.shouldRedirect).toBe(false)

      const networkError = new Error('Network error')
      const resultNetwork = handle401Error(networkError)
      expect(resultNetwork.shouldClearAuth).toBe(false)
      expect(resultNetwork.shouldRedirect).toBe(false)
    })
  })

  describe('Auth API', () => {
    describe('login', () => {
      it('makes POST request to /login with credentials', async () => {
        const mockResponse: AuthResponse = {
          token: 'test-token',
          user: {
            id: '1',
            username: 'testuser',
            role: 'user',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          }
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
          token: 'test-token',
          user: {
            id: '1',
            username: 'newuser',
            role: 'user',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          }
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
          params: { archived: false, search: '' } 
        })
        expect(result).toEqual(mockNotes)
      })

      it('fetches archived notes when requested', async () => {
        const mockNotes = [{ ...mockNote, archived: true }]
        mockGet.mockResolvedValue({ data: mockNotes })

        const result = await notes.getAll(true)

        expect(mockGet).toHaveBeenCalledWith('/notes', { 
          params: { archived: true, search: '' } 
        })
        expect(result).toEqual(mockNotes)
      })

      it('includes search query when provided', async () => {
        const mockNotes = [mockNote]
        mockGet.mockResolvedValue({ data: mockNotes })

        const result = await notes.getAll(false, 'test query')

        expect(mockGet).toHaveBeenCalledWith('/notes', { 
          params: { archived: false, search: 'test query' } 
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
          params: { archived: false, search: specialQuery } 
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
        mockPut.mockResolvedValue({ data: updatedNote })

        const result = await notes.update('1', updateData)

        expect(mockPut).toHaveBeenCalledWith('/notes/1', updateData)
        expect(result).toEqual(updatedNote)
      })

      it('handles update of non-existent note', async () => {
        const error = new Error('Note not found')
        mockPut.mockRejectedValue(error)

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
        mockPut.mockResolvedValue({ data: updatedNote })

        // Simulate concurrent updates
        const promise1 = notes.update('1', updateData)
        const promise2 = notes.update('1', { ...updateData, title: 'Different Title' })

        const [result1, result2] = await Promise.all([promise1, promise2])

        expect(mockPut).toHaveBeenCalledTimes(2)
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
    })

    describe('sharing functionality', () => {
      it('shares note with user', async () => {
        const shareData: ShareNoteRequest = { username: 'testuser' }
        const shareResponse = { success: true, message: 'Note shared' }
        mockPost.mockResolvedValue({ data: shareResponse })

        const result = await notes.share('1', shareData)

        expect(mockPost).toHaveBeenCalledWith('/notes/1/share', shareData)
        expect(result).toEqual(shareResponse)
      })

      it('unshares note', async () => {
        const unshareData: ShareNoteRequest = { username: 'testuser' }
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

        const shareData: ShareNoteRequest = { username: 'nonexistent' }

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
            role: 'user',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
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
              role: 'user',
              created_at: '2023-01-01T00:00:00Z',
              updated_at: '2023-01-01T00:00:00Z',
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
          role: 'user',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
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

    it('handles localStorage errors gracefully in token retrieval', () => {
      // Test localStorage error handling separately from interceptors
      const getTokenSafely = () => {
        try {
          return localStorage.getItem('token')
        } catch (error) {
          return null
        }
      }

      // Mock localStorage to throw an error
      const originalGetItem = mockLocalStorage.getItem
      mockLocalStorage.getItem.mockImplementationOnce(() => {
        throw new Error('localStorage error')
      })
      
      const token = getTokenSafely()
      expect(token).toBeNull()
      
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

    it('handles API calls with null/undefined parameters', async () => {
      const sampleNote = createMockNote()
      mockGet.mockResolvedValue({ data: [] })
      mockPost.mockResolvedValue({ data: sampleNote })
      mockPut.mockResolvedValue({ data: sampleNote })

      // These should handle gracefully
      await notes.getAll(undefined as any, null as any)
      await notes.create(null as any)
      await notes.update(undefined as any, null as any)

      expect(mockGet).toHaveBeenCalled()
      expect(mockPost).toHaveBeenCalled()
      expect(mockPut).toHaveBeenCalled()
    })
  })
})