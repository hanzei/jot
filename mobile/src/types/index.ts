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

export interface UserSettings {
  user_id: string;
  language: string;
  theme: ThemePreference;
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

export interface GetNotesParams {
  archived?: boolean;
  search?: string;
  trashed?: boolean;
  label?: string;
}

export interface CreateNoteRequest {
  title: string;
  content: string;
  note_type: NoteType;
  color?: string;
  items?: { text: string; position: number; completed?: boolean; indent_level?: number; assigned_to?: string }[];
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
