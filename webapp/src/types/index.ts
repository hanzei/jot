export interface User {
  id: string;
  email: string;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
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
  user_email?: string;
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
  email: string;
  password: string;
  is_admin: boolean;
}

export interface UserListResponse {
  users: User[];
}

export interface ShareNoteRequest {
  email: string;
}

export interface ShareNoteResponse {
  success: boolean;
  message: string;
}