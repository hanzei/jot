export interface ServerConfig {
  registration_enabled: boolean;
  password_min_length: number;
}

export interface AboutInfo {
  version: string;
  commit: string;
  build_time?: string;
  go_version?: string;
}

export type UserRole = 'user' | 'admin';

export interface User {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: UserRole;
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

export type NoteType = 'text' | 'list';

export interface NoteItem {
  id: string;
  note_id: string;
  text: string;
  completed: boolean;
  position: number;
  /**
   * The item this one is nested under, or null for a top-level item. A "group"
   * is a top-level item plus the items whose parent_id points at it. Replaces
   * the former indent_level column (a child renders one level indented). The
   * server always sends it; it is optional here only so the not-yet-migrated
   * mobile client (which does not yet read it) still type-checks.
   */
  parent_id?: string | null;
  /**
   * @deprecated Removed from the API; the server no longer returns it (grouping
   * is keyed off parent_id). Retained as optional only so the not-yet-migrated
   * mobile client still type-checks; it renders items flat until it adopts
   * parent_id.
   */
  indent_level?: number;
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

interface BaseNote {
  id: string;
  user_id: string;
  note_type: NoteType;
  color: string;
  pinned: boolean;
  archived: boolean;
  position: number;
  shared_with?: NoteShare[];
  is_shared: boolean;
  labels: Label[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TextNote extends BaseNote {
  note_type: 'text';
  content: string;
}

export interface ListNote extends BaseNote {
  note_type: 'list';
  title: string;
  items?: NoteItem[];
  checked_items_collapsed: boolean;
}

export type Note = TextNote | ListNote;

export interface GetNotesParams {
  archived?: boolean;
  search?: string;
  trashed?: boolean;
  label?: string;
  my_tasks?: boolean;
  /** Used locally to filter my-tasks notes by assigned_to; not sent to the server. */
  user_id?: string;
}

export interface CreateNoteItemRequest {
  /**
   * Client-supplied item ID. Optional for bulk creation at note-creation time
   * (the server generates one when omitted); supplied by the granular
   * `POST /notes/{id}/items` endpoint so the item has a stable identity for
   * subsequent per-item updates and offline replay.
   */
  id?: string;
  text: string;
  position: number;
  completed?: boolean;
  /**
   * Positional grouping hint used only by the bulk note-creation path
   * (`POST /notes` with items): 0 = top-level, 1 = indented. The server
   * reconstructs `parent_id` from it by attaching each indented item to the
   * nearest preceding top-level item. The granular `POST /notes/{id}/items`
   * endpoint ignores this and uses `parent_id` instead.
   */
  indent_level?: number;
  /** Nests the new item under a top-level item (granular create only). */
  parent_id?: string | null;
  assigned_to?: string;
}

/**
 * Partial update for a single list item via `PATCH /notes/{id}/items/{itemId}`.
 * Only the provided fields are changed, so concurrent edits to different
 * columns of the same item (e.g. one client toggling `completed` while another
 * edits `text`) merge instead of overwriting each other.
 */
export interface PatchNoteItemRequest {
  text?: string;
  completed?: boolean;
  position?: number;
  /** Re-parents the item; empty string makes it top-level, null leaves it unchanged. */
  parent_id?: string | null;
  /**
   * @deprecated The granular item endpoints ignore this; grouping is set via
   * parent_id. Retained only so the not-yet-migrated mobile client compiles.
   */
  indent_level?: number;
  assigned_to?: string;
}

/** Reorder a list's items via `POST /notes/{id}/items/reorder`. */
export interface ReorderNoteItemsRequest {
  item_ids: string[];
}

export interface CreateTextNoteRequest {
  content: string;
  note_type: 'text';
  color?: string;
  labels?: string[];
}

export interface CreateListNoteRequest {
  title: string;
  note_type: 'list';
  color?: string;
  items?: CreateNoteItemRequest[];
  labels?: string[];
}

export type CreateNoteRequest = CreateTextNoteRequest | CreateListNoteRequest;

export interface UpdateTextNoteRequest {
  content?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
}

export interface UpdateListNoteRequest {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
  checked_items_collapsed?: boolean;
}

export type UpdateNoteRequest = UpdateTextNoteRequest | UpdateListNoteRequest;

export interface CreateUserRequest {
  username: string;
  password: string;
  role: UserRole;
}

export interface UserListResponse {
  users: User[];
}

export interface AdminUserStats {
  total: number;
  admins: number;
}

export interface AdminNoteStats {
  total: number;
  text: number;
  list: number;
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

export interface AdminListItemStats {
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
  list_items: AdminListItemStats;
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

export interface ImportResponse {
  imported: number;
  skipped: number;
  errors?: string[];
}

export interface EmptyTrashResponse {
  deleted: number;
}

export interface UpdateUserRoleRequest {
  role: UserRole;
}

export interface ActiveSession {
  id: string;
  browser: string;
  os: string;
  is_current: boolean;
  created_at: string;
  expires_at: string;
}

export interface NoteSSEEvent {
  type: 'note_created' | 'note_updated' | 'note_deleted' | 'note_shared' | 'note_unshared';
  source_user_id: string;
  target_user_id?: string;
  client_id?: string;
  data: {
    note_id: string;
    note: Note | null;
  };
}

export interface LabelsChangedSSEEvent {
  type: 'labels_changed';
  source_user_id: string;
  client_id?: string;
  data: {
    label: Label;
  };
}

export interface PersonalAccessToken {
  id: string;
  name: string;
  created_at: string;
  /** Only present in the create response; never returned by list. */
  token?: string;
}

export interface CreatePATRequest {
  name: string;
}

export interface ProfileIconSSEEvent {
  type: 'profile_icon_updated';
  source_user_id: string;
  client_id?: string;
  data: {
    user: User;
  };
}

export type SSEEvent = NoteSSEEvent | LabelsChangedSSEEvent | ProfileIconSSEEvent;
