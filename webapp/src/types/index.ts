export interface User {
  id: string;
  username: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface AuthResponse {
  user: User;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export type NoteType = 'text' | 'todo';

export interface NoteItem {
  id: string;
  note_id: string;
  text: string;
  completed: boolean;
  position: number;
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
  created_at: string;
  updated_at: string;
}

export interface CreateNoteRequest {
  title: string;
  content: string;
  note_type: NoteType;
  color?: string;
  items?: { text: string; position: number; completed?: boolean }[];
}

export interface UpdateNoteRequest {
  title: string;
  content: string;
  pinned: boolean;
  archived: boolean;
  color: string;
  checked_items_collapsed: boolean;
  items?: { text: string; position: number; completed?: boolean }[];
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role: string;
}

export interface UserListResponse {
  users: User[];
}

export interface ShareNoteRequest {
  username: string;
}

export interface ShareNoteResponse {
  success: boolean;
  message: string;
}

export interface ImportResponse {
  imported: number;
  skipped: number;
}