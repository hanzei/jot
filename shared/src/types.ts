export interface ServerConfig {
  registration_enabled: boolean;
}

export interface AboutInfo {
  version: string;
  commit: string;
  build_time?: string;
  go_version?: string;
}

export interface User {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: string;
  has_profile_icon: boolean;
  created_at: string;
  updated_at: string;
}

export type ThemePreference = 'system' | 'light' | 'dark';
export type NoteSort = 'manual' | 'updated_at' | 'created_at';

export interface UserSettings {
  user_id: string;
  language: string;
  theme: ThemePreference;
  note_sort: NoteSort;
  updated_at: string;
}

export interface AuthResponse {
  user: User;
  settings: UserSettings;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface Label {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type NoteType = 'text' | 'todo';

export interface NoteItem {
  id: string;
  note_id: string;
  text: string;
  completed: boolean;
  position: number;
  indent_level: number;
  assigned_to: string;
  created_at: string;
  updated_at: string;
}

export interface NoteShare {
  id: string;
  note_id: string;
  shared_with_user_id: string;
  shared_by_user_id: string;
  permission_level: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  has_profile_icon?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  user_id: string;
  title: string;
  content: string;
  note_type: NoteType;
  color: string;
  pinned: boolean;
  archived: boolean;
  position: number;
  checked_items_collapsed: boolean;
  items?: NoteItem[];
  shared_with?: NoteShare[];
  is_shared: boolean;
  labels: Label[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GetNotesParams {
  archived?: boolean;
  search?: string;
  trashed?: boolean;
  label?: string;
  my_todo?: boolean;
  /** Used locally to filter my-todo notes by assigned_to; not sent to the server. */
  user_id?: string;
}

export interface CreateNoteRequest {
  title: string;
  content: string;
  note_type: NoteType;
  color?: string;
  items?: { text: string; position: number; completed?: boolean; indent_level?: number }[];
  labels?: string[];
}

export interface UpdateNoteRequest {
  title?: string;
  content?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
  checked_items_collapsed?: boolean;
  items?: { text: string; position: number; completed?: boolean; indent_level?: number; assigned_to?: string }[];
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role: string;
}

export interface UserListResponse {
  users: User[];
}

export interface AdminUserStats {
  total: number;
}

export interface AdminNoteStats {
  total: number;
  text: number;
  todo: number;
  trashed: number;
  archived: number;
}

export interface AdminSharingStats {
  shared_notes: number;
  share_links: number;
}

export interface AdminLabelStats {
  total: number;
  note_associations: number;
}

export interface AdminTodoItemStats {
  total: number;
  completed: number;
  assigned: number;
}

export interface AdminStorageStats {
  database_size_bytes: number;
}

export interface AdminStatsResponse {
  users: AdminUserStats;
  notes: AdminNoteStats;
  sharing: AdminSharingStats;
  labels: AdminLabelStats;
  todo_items: AdminTodoItemStats;
  storage: AdminStorageStats;
}

export interface UpdateMeRequest {
  username?: string;
  first_name?: string;
  last_name?: string;
  language?: string;
  theme?: ThemePreference;
  note_sort?: NoteSort;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface ShareNoteRequest {
  user_id: string;
}

export interface ShareNoteResponse {
  success: boolean;
  message: string;
}

export interface ImportResponse {
  imported: number;
  skipped: number;
  errors?: string[];
}

export interface EmptyTrashResponse {
  deleted: number;
}

export interface UpdateUserRoleRequest {
  role: string;
}

export interface ActiveSession {
  id: string;
  browser: string;
  os: string;
  is_current: boolean;
  created_at: string;
  expires_at: string;
}

export type SSEEventType =
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'note_shared'
  | 'note_unshared';

export interface SSEEvent {
  type: SSEEventType;
  note_id: string;
  note: Note | null;
  source_user_id: string;
  target_user_id?: string;
}
