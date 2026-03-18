import axios from 'axios';
import type { AboutInfo, AuthResponse, LoginRequest, RegisterRequest, Note, CreateNoteRequest, UpdateNoteRequest, User, CreateUserRequest, UserListResponse, ShareNoteRequest, ShareNoteResponse, NoteShare, ImportResponse, UpdateMeRequest, ChangePasswordRequest, UpdateUserRoleRequest, Label, ActiveSession } from '@jot/shared';

const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
});

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      const isAuthEndpoint = url === '/login' || url === '/register' || url === '/me';
      if (!isAuthEndpoint) {
        localStorage.removeItem('user');
        localStorage.removeItem('settings');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export const auth = {
  login: (data: LoginRequest): Promise<AuthResponse> =>
    api.post('/login', data).then(res => res.data),

  register: (data: RegisterRequest): Promise<AuthResponse> =>
    api.post('/register', data).then(res => res.data),

  logout: (): Promise<void> =>
    api.post('/logout'),

  me: (): Promise<AuthResponse> =>
    api.get('/me').then(res => res.data),
};

export const notes = {
  getAll: (archived = false, search = '', trashed = false, labelId = '', myTodo = false): Promise<Note[]> =>
    api.get('/notes', { params: { archived, search, trashed, ...(labelId ? { label: labelId } : {}), ...(myTodo ? { my_todo: true } : {}) } }).then(res => res.data),

  getById: (id: string): Promise<Note> =>
    api.get(`/notes/${id}`).then(res => res.data),

  create: (data: CreateNoteRequest): Promise<Note> =>
    api.post('/notes', data).then(res => res.data),

  update: (id: string, data: UpdateNoteRequest): Promise<Note> =>
    api.patch(`/notes/${id}`, data).then(res => res.data),

  delete: (id: string, opts?: { permanent?: boolean }): Promise<void> =>
    opts?.permanent
      ? api.delete(`/notes/${id}`, { params: { permanent: true } })
      : api.delete(`/notes/${id}`),

  restore: (id: string): Promise<Note> =>
    api.post(`/notes/${id}/restore`).then(res => res.data),

  share: (id: string, data: ShareNoteRequest): Promise<ShareNoteResponse> =>
    api.post(`/notes/${id}/share`, data).then(res => res.data),

  unshare: (id: string, data: ShareNoteRequest): Promise<ShareNoteResponse> =>
    api.delete(`/notes/${id}/share`, { data }).then(res => res.data),

  getShares: (id: string): Promise<NoteShare[]> =>
    api.get(`/notes/${id}/shares`).then(res => res.data),

  reorder: (noteIDs: string[]): Promise<void> =>
    api.post('/notes/reorder', { note_ids: noteIDs }),

  importKeep: (file: File): Promise<ImportResponse> => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/notes/import', formData).then(res => res.data);
  },

  addLabel: (noteId: string, name: string): Promise<Note> =>
    api.post(`/notes/${noteId}/labels`, { name }).then(res => res.data),

  removeLabel: (noteId: string, labelId: string): Promise<Note> =>
    api.delete(`/notes/${noteId}/labels/${labelId}`).then(res => res.data),
};

export const labels = {
  getAll: (): Promise<Label[]> =>
    api.get('/labels').then(res => res.data),
};

export const users = {
  search: (): Promise<User[]> =>
    api.get('/users').then(res => res.data),

  updateMe: (data: UpdateMeRequest): Promise<AuthResponse> =>
    api.patch('/users/me', data).then(res => res.data),

  changePassword: (data: ChangePasswordRequest): Promise<void> =>
    api.put('/users/me/password', data),

  uploadProfileIcon: (file: File): Promise<User> => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/users/me/profile-icon', formData).then(res => res.data);
  },

  deleteProfileIcon: (): Promise<void> =>
    api.delete('/users/me/profile-icon'),
};

export const sessions = {
  list: (): Promise<ActiveSession[]> =>
    api.get('/sessions').then(res => res.data),

  revoke: (id: string): Promise<void> =>
    api.delete(`/sessions/${id}`).then(() => undefined),
};

export const about = {
  get: (): Promise<AboutInfo> =>
    api.get('/about').then(res => res.data),
};

export const admin = {
  getUsers: (): Promise<UserListResponse> =>
    api.get('/admin/users').then(res => res.data),

  createUser: (data: CreateUserRequest): Promise<User> =>
    api.post('/admin/users', data).then(res => res.data),

  updateUserRole: (id: string, data: UpdateUserRoleRequest): Promise<User> =>
    api.put(`/admin/users/${id}/role`, data).then(res => res.data),

  deleteUser: (id: string): Promise<void> =>
    api.delete(`/admin/users/${id}`).then(() => undefined),
};

export { isAxiosError } from 'axios';

export default api;
