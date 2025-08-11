export interface User {
  id: string;
  username: string;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthResponse {
  token: string;
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
  id: number;
  note_id: number;
  text: string;
  completed: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface NoteShare {
  id: number;
  note_id: number;
  shared_with_user_id: string;
  shared_by_user_id: string;
  permission_level: string;
  username?: string;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: number;
  user_id: string;
  title: string;
  content: string;
  note_type: NoteType;
  color: string;
  pinned: boolean;
  archived: boolean;
  position: number;
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
  items?: { text: string; position: number; completed?: boolean }[];
}

export interface CreateUserRequest {
  username: string;
  password: string;
  is_admin: boolean;
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