import axios from 'axios';
import type {
  ServerConfig,
  AboutInfo,
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  Note,
  CreateNoteRequest,
  UpdateNoteRequest,
  User,
  UserInfo,
  CreateUserRequest,
  UserListResponse,
  AdminStatsResponse,
  ShareNoteRequest,
  ShareNoteResponse,
  NoteShare,
  ImportResponse,
  UpdateMeRequest,
  ChangePasswordRequest,
  UpdateUserRoleRequest,
  Label,
  ActiveSession,
  EmptyTrashResponse,
  GetNotesParams,
  PaginationParams,
  PaginatedNotesResponse,
  PaginatedUsersResponse,
  PaginatedSessionsResponse,
} from '@jot/shared';

const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
});

const CLIENT_PAGE_SIZE = 100;

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

export const serverConfig = {
  get: (): Promise<ServerConfig> =>
    api.get('/config').then(res => res.data),
};

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

async function collectAllPages<T, TResponse extends { items: T[]; pagination: { has_more: boolean; next_offset?: number } }>(
  path: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const items: T[] = [];
  const limit = typeof params.limit === 'number' ? params.limit : CLIENT_PAGE_SIZE;
  let offset = typeof params.offset === 'number' ? params.offset : 0;

  for (;;) {
    const response = await api.get<TResponse>(path, { params: { ...params, limit, offset } }).then(res => res.data);
    items.push(...response.items);

    if (!response.pagination.has_more || response.pagination.next_offset === undefined) {
      return items;
    }

    offset = response.pagination.next_offset;
  }
}

export const notes = {
  listPage: (params: GetNotesParams = {}): Promise<PaginatedNotesResponse> => {
    const { user_id: _userId, ...requestParams } = params;
    return api.get('/notes', { params: requestParams }).then(res => res.data);
  },

  getAll: (archived = false, search = '', trashed = false, labelId = '', myTodo = false): Promise<Note[]> =>
    collectAllPages<Note, PaginatedNotesResponse>('/notes', {
      archived,
      search,
      trashed,
      limit: CLIENT_PAGE_SIZE,
      ...(labelId ? { label: labelId } : {}),
      ...(myTodo ? { my_todo: true } : {}),
    }),

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

  emptyTrash: (): Promise<EmptyTrashResponse> =>
    api.delete('/notes/trash').then(res => res.data),

  restore: (id: string): Promise<Note> =>
    api.post(`/notes/${id}/restore`).then(res => res.data),

  duplicate: (id: string): Promise<Note> =>
    api.post(`/notes/${id}/duplicate`).then(res => res.data),

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

  rename: (id: string, name: string): Promise<Label> =>
    api.patch(`/labels/${id}`, { name }).then(res => res.data),

  delete: (id: string): Promise<void> =>
    api.delete(`/labels/${id}`).then(() => undefined),
};

export const users = {
  listPage: (params: PaginationParams & { search?: string } = {}): Promise<PaginatedUsersResponse> =>
    api.get('/users', { params }).then(res => res.data),

  search: (search = ''): Promise<UserInfo[]> =>
    collectAllPages<UserInfo, PaginatedUsersResponse>('/users', {
      limit: CLIENT_PAGE_SIZE,
      ...(search ? { search } : {}),
    }),

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
  listPage: (params: PaginationParams = {}): Promise<PaginatedSessionsResponse> =>
    api.get('/sessions', { params }).then(res => res.data),

  list: (): Promise<ActiveSession[]> =>
    collectAllPages<ActiveSession, PaginatedSessionsResponse>('/sessions', { limit: CLIENT_PAGE_SIZE }),

  revoke: (id: string): Promise<void> =>
    api.delete(`/sessions/${id}`).then(() => undefined),
};

export const about = {
  get: (): Promise<AboutInfo> =>
    api.get('/about').then(res => res.data),
};

export const admin = {
  getStats: (): Promise<AdminStatsResponse> =>
    api.get('/admin/stats').then(res => res.data),

  getUsersPage: (params: PaginationParams = {}): Promise<UserListResponse> =>
    api.get('/admin/users', { params }).then(res => res.data),

  getUsers: async (): Promise<UserListResponse> => {
    const items = await collectAllPages<User, UserListResponse>('/admin/users', { limit: CLIENT_PAGE_SIZE });
    return {
      items,
      pagination: {
        limit: CLIENT_PAGE_SIZE,
        offset: 0,
        returned: items.length,
        has_more: false,
      },
    };
  },

  createUser: (data: CreateUserRequest): Promise<User> =>
    api.post('/admin/users', data).then(res => res.data),

  updateUserRole: (id: string, data: UpdateUserRoleRequest): Promise<User> =>
    api.put(`/admin/users/${id}/role`, data).then(res => res.data),

  deleteUser: (id: string): Promise<void> =>
    api.delete(`/admin/users/${id}`).then(() => undefined),
};

export { isAxiosError } from 'axios';

export default api;
