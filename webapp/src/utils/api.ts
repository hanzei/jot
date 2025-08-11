import axios from 'axios';
import { AuthResponse, LoginRequest, RegisterRequest, Note, CreateNoteRequest, UpdateNoteRequest, User, CreateUserRequest, UserListResponse, ShareNoteRequest, ShareNoteResponse, NoteShare } from '@/types';

const api = axios.create({
  baseURL: '/api/v1',
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const auth = {
  login: (data: LoginRequest): Promise<AuthResponse> =>
    api.post('/login', data).then(res => res.data),
  
  register: (data: RegisterRequest): Promise<AuthResponse> =>
    api.post('/register', data).then(res => res.data),
};

export const notes = {
  getAll: (archived = false, search = ''): Promise<Note[]> =>
    api.get('/notes', { params: { archived, search } }).then(res => res.data),
  
  getById: (id: string): Promise<Note> =>
    api.get(`/notes/${id}`).then(res => res.data),
  
  create: (data: CreateNoteRequest): Promise<Note> =>
    api.post('/notes', data).then(res => res.data),
  
  update: (id: string, data: UpdateNoteRequest): Promise<Note> =>
    api.put(`/notes/${id}`, data).then(res => res.data),
  
  delete: (id: string): Promise<void> =>
    api.delete(`/notes/${id}`),
  
  share: (id: string, data: ShareNoteRequest): Promise<ShareNoteResponse> =>
    api.post(`/notes/${id}/share`, data).then(res => res.data),
  
  unshare: (id: string, data: ShareNoteRequest): Promise<ShareNoteResponse> =>
    api.delete(`/notes/${id}/share`, { data }).then(res => res.data),
  
  getShares: (id: string): Promise<NoteShare[]> =>
    api.get(`/notes/${id}/shares`).then(res => res.data),
  
  reorder: (noteIDs: string[]): Promise<void> =>
    api.post('/notes/reorder', { note_ids: noteIDs }),
};

export const users = {
  search: (): Promise<User[]> =>
    api.get('/users').then(res => res.data),
};

export const admin = {
  getUsers: (): Promise<UserListResponse> =>
    api.get('/admin/users').then(res => res.data),
  
  createUser: (data: CreateUserRequest): Promise<User> =>
    api.post('/admin/users', data).then(res => res.data),
};

export default api;