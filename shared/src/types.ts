/**
 * Public SSO slice of the server config, surfaced by `GET /config`. Never
 * exposes issuer/client internals — only what the login UI needs to render the
 * provider button and decide whether to keep the password form. `enabled` is
 * false when no OIDC provider is configured.
 */
export interface SSOConfig {
  enabled: boolean;
  provider_name: string;
  local_login_enabled: boolean;
}

export interface ServerConfig {
  registration_enabled: boolean;
  password_min_length: number;
  upload_max_bytes: number;
  /**
   * SSO/OIDC login config. Optional so pre-SSO servers (and cached configs
   * from them) stay valid; clients default a missing value to disabled. Current servers always include it (with `enabled: false` when
   * unconfigured).
   */
  sso?: SSOConfig;
}

export interface AboutInfo {
  version: string;
  commit: string;
  build_time?: string;
  go_version?: string;
}

/**
 * A render error caught by an error boundary, as both clients' diagnostics
 * reports carry it. Name, message and stacks only — never props or state.
 */
export interface DiagnosticsCrash {
  name: string;
  message: string;
  stack: string | null;
  componentStack: string | null;
}

export type UserRole = 'user' | 'admin';

export interface User {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  has_profile_icon: boolean;
  /**
   * True when an OIDC/SSO identity is bound to this account
   * (`oidc_subject IS NOT NULL`). The server populates it on every user
   * response; optional here so the mobile app and existing fixtures — which
   * have no SSO concept in v1 — need not construct it. Read it with a
   * `?? false` default.
   */
  has_sso_linked?: boolean;
  /**
   * False for an account with no password (`password_hash IS NULL`), e.g. one
   * created by SSO sign-in. Such a user sets a first password without
   * `current_password`. Optional like `has_sso_linked`; read it with a
   * `?? true` default so an absent flag keeps the Change Password form.
   */
  has_password?: boolean;
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

export interface LabelCount {
  label_id: string;
  count: number;
}

export interface LabelCountsResponse {
  counts: LabelCount[];
}

/** GET /labels */
export interface LabelListResponse {
  labels: Label[];
}

export type NoteType = 'text' | 'list';

export interface NoteItem {
  id: string;
  note_id: string;
  text: string;
  completed: boolean;
  position: number;
  /** The item this one is nested under, or null for a top-level item. */
  parent_id: string | null;
  assigned_to: string;
  created_at: string;
  updated_at: string;
}

export interface NoteShare {
  id: string;
  note_id: string;
  shared_with_user_id: string;
  shared_by_user_id: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  has_profile_icon?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Metadata for an image attached to a note. Embedded on `Note.images`; a
 * narrow field set by design so the note list payload stays small. Image
 * bytes are fetched out-of-band from `GET /api/images/{id}` (and
 * `/thumbnail`), never inlined here.
 */
export interface NoteImage {
  id: string;
  filename: string;
  content_type: string;
  width: number;
  height: number;
  created_at: string;
}

export type NoteUnread = 'new' | 'updated';

interface BaseNote {
  id: string;
  user_id: string;
  note_type: NoteType;
  /**
   * Optimistic-concurrency counter bumped server-side on every shared-content
   * (title/content) change. Echo it as `base_version` on an update so a stale
   * write is rejected with 409 instead of silently clobbering a newer edit made
   * on another device (issue #489).
   */
  version: number;
  color: string;
  pinned: boolean;
  archived: boolean;
  position: number;
  shared_with?: NoteShare[];
  is_shared: boolean;
  /**
   * The requesting user's unread badge: `'new'` for a note shared with them
   * that they never opened, `'updated'` when someone else changed its shared
   * content since they last opened it, `null` when there is nothing new.
   * Cleared by `POST /notes/{id}/viewed`.
   */
  unread: NoteUnread | null;
  labels: Label[];
  images?: NoteImage[];
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

/** GET /notes */
export interface NoteListResponse {
  notes: Note[];
}

/** GET /notes/{id}/shares */
export interface NoteShareListResponse {
  shares: NoteShare[];
}

export interface GetNotesParams {
  archived?: boolean | undefined;
  search?: string | undefined;
  trashed?: boolean | undefined;
  label?: string | undefined;
  my_tasks?: boolean | undefined;
  /** Used locally to filter my-tasks notes by assigned_to; not sent to the server. */
  user_id?: string | undefined;
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
  /**
   * Nests the new item under a top-level item (granular create only); `''`
   * means top-level, matching the server's plain-string field.
   */
  parent_id?: string;
  assigned_to?: string | undefined;
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
  assigned_to?: string;
}

/** Reorder a list's items via `POST /notes/{id}/items/reorder`. */
export interface ReorderNoteItemsRequest {
  item_ids: string[];
}

export interface CreateTextNoteRequest {
  /**
   * Optional client-supplied note ID. When provided, the server uses it as the
   * note's primary key, making an offline-created note's replayed POST
   * idempotent (a replay of an already-committed create returns 409 instead of
   * duplicating). Omit to let the server generate one.
   */
  id?: string;
  content: string;
  note_type: 'text';
  color?: string | undefined;
  labels?: string[] | undefined;
  /**
   * Create the note already pinned for the creating user (pinned is per-user
   * state). Lets a client pin a note before it exists without a follow-up
   * PATCH. Omitted means unpinned.
   */
  pinned?: boolean | undefined;
}

export interface CreateListNoteRequest {
  /** Optional client-supplied note ID; see {@link CreateTextNoteRequest.id}. */
  id?: string;
  title: string;
  note_type: 'list';
  color?: string | undefined;
  items?: CreateNoteItemRequest[];
  labels?: string[] | undefined;
  /** Create the note already pinned; see {@link CreateTextNoteRequest.pinned}. */
  pinned?: boolean | undefined;
}

export type CreateNoteRequest = CreateTextNoteRequest | CreateListNoteRequest;

/**
 * Optimistic-concurrency guard shared by both update-request shapes: the note
 * `version` the edit was based on. When present, the server rejects the write
 * with 409 if the note's content changed since (issue #489); only meaningful
 * alongside a `title`/`content` change, so it is omitted for per-user-only edits.
 */
interface BaseUpdateNoteRequest {
  base_version?: number;
}

export interface UpdateTextNoteRequest extends BaseUpdateNoteRequest {
  content?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
}

export interface UpdateListNoteRequest extends BaseUpdateNoteRequest {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
  checked_items_collapsed?: boolean;
}

export type UpdateNoteRequest = UpdateTextNoteRequest | UpdateListNoteRequest;

/**
 * Request body for `POST /notes/{id}/convert`, which changes a note's type in
 * place. The transform (splitting text into list items, or rendering a list
 * back into text) is computed client-side via `textToListNote`/`listToText`
 * (see `noteConversion.ts`) and sent precomputed; the server only validates
 * and persists it. `content` is used when converting to `text`; `title` and
 * `items` when converting to `list`.
 */
export interface ConvertNoteTypeRequest extends BaseUpdateNoteRequest {
  note_type: NoteType;
  content?: string;
  /**
   * The converted list's title, promoted from a leading heading in the text
   * content. Omitted (or '') leaves the note untitled, which is what the
   * server stored unconditionally before this field existed.
   */
  title?: string;
  items?: CreateNoteItemRequest[];
}

/** A list item as stored in a note revision. */
export type NoteRevisionItem = Omit<NoteItem, 'note_id' | 'created_at' | 'updated_at'>;

/**
 * A note revision's metadata, as listed by `GET /notes/{id}/revisions`. A
 * revision is the note's shared content (type, title, content, items) as it was
 * just before a write replaced it. Writes from one user and client within 10
 * minutes coalesce into one revision; images are not part of a revision.
 */
export interface NoteRevisionSummary {
  id: string;
  note_id: string;
  note_type: NoteType;
  /** Always '' for a text note. */
  title: string;
  /**
   * Who last edited the snapshotted content, or `null` when that is unknown
   * (content never edited since the note was created, or written before edits
   * were attributed). May name a user who has since been deleted.
   */
  actor_id: string | null;
  /** When the snapshotted content was last edited. Show this one. */
  edited_at: string;
  /** When a write replaced this content. */
  created_at: string;
}

/** `GET /notes/{id}/revisions/{revision_id}`. */
export interface NoteRevision extends NoteRevisionSummary {
  /** Set for a text note, '' for a list. */
  content: string;
  /** Set for a list note, `[]` for text. */
  items: NoteRevisionItem[];
}

/** `GET /notes/{id}/revisions`, newest first. */
export interface NoteRevisionListResponse {
  revisions: NoteRevisionSummary[];
}

/**
 * Request body for `POST /notes/{id}/revisions/{revision_id}/restore`, which
 * responds with the restored `Note`. The restore records the content it
 * replaces as a new revision, so it can be undone the same way.
 */
export type RestoreNoteRevisionRequest = BaseUpdateNoteRequest;

export interface CreateUserRequest {
  username: string;
  password: string;
  role: UserRole;
}

export interface UserListResponse {
  users: User[];
}

/**
 * GET /users. With a `search` term the server returns at most 50 matches and
 * sets `truncated` when there were more; without one it lists every user and
 * `truncated` is false.
 */
export interface UserSearchResponse {
  users: User[];
  truncated: boolean;
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
  image_count: number;
  images_size_bytes: number;
}

export interface AdminUploadVolumeStats {
  free_bytes: number;
  total_bytes: number;
}

export interface AdminRuntimeStats {
  database_backend: 'sqlite' | 'postgres';
  migration_version: number;
  migration_dirty: boolean;
  started_at: string;
  uptime_seconds: number;
  sse_subscribers: number;
  active_sessions: number;
  /** Null when the server cannot read the upload volume's usage. */
  upload_volume: AdminUploadVolumeStats | null;
}

export interface AdminStatsResponse {
  users: AdminUserStats;
  notes: AdminNoteStats;
  sharing: AdminSharingStats;
  labels: AdminLabelStats;
  list_items: AdminListItemStats;
  storage: AdminStorageStats;
  runtime: AdminRuntimeStats;
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
  /** Omitted when the user has no password yet (`has_password` false). */
  current_password?: string;
  new_password: string;
}

export interface ShareNoteRequest {
  user_id: string;
}

/** The `import_type` values `POST /notes/import` accepts with an uploaded file. */
export type FileImportType = 'google_keep' | 'jot_json';

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

export interface SetUserPasswordRequest {
  new_password: string;
}

export interface ActiveSession {
  id: string;
  browser: string;
  os: string;
  is_current: boolean;
  created_at: string;
  expires_at: string;
}

/** GET /sessions */
export interface SessionListResponse {
  sessions: ActiveSession[];
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

/** GET /pats */
export interface PATListResponse {
  pats: PersonalAccessToken[];
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

/**
 * Fired when an image is added to or removed from a note. `image` is set for
 * note_image_added; `image_id` is set for note_image_removed (the row is
 * already gone by the time that event fires).
 */
export interface NoteImageSSEEvent {
  type: 'note_image_added' | 'note_image_removed';
  source_user_id: string;
  client_id?: string;
  data: {
    note_id: string;
    image?: NoteImage;
    image_id?: string;
  };
}

export type SSEEvent = NoteSSEEvent | LabelsChangedSSEEvent | ProfileIconSSEEvent | NoteImageSSEEvent;

/**
 * Stable, machine-readable code carried by every API error response. Keep in
 * sync with the Code constants in server/internal/apierr/apierr.go; the
 * swagger spec (server/docs/swagger.yaml, `apierr.Code`) documents each one.
 *
 * Generic codes (one per status class): validation_failed (400),
 * unauthorized (401), forbidden (403), not_found (404), method_not_allowed
 * (405), conflict (409), request_too_large (413), limit_exceeded (422),
 * rate_limited (429), bad_request (any other 4xx), internal (5xx). The rest
 * are specific codes for cases a client needs to tell apart.
 *
 * A newer server may send a code this list does not know yet; treat an
 * unrecognized code like the generic code for the response's status.
 */
export type ApiErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'request_too_large'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'bad_request'
  | 'internal'
  | 'invalid_credentials'
  | 'session_required'
  | 'registration_disabled'
  | 'local_login_disabled'
  | 'incorrect_password'
  | 'username_taken'
  | 'cannot_share_with_self'
  | 'already_shared'
  | 'label_name_taken'
  | 'last_admin'
  | 'cannot_delete_self'
  | 'sso_identity_linked'
  | 'would_strand_account'
  | 'label_name_too_long'
  | 'item_limit_reached'
  | 'image_limit_reached'
  | 'pat_limit_reached'
  | 'unsupported_image_type'
  | 'invalid_image'
  | 'invalid_import_file'
  | 'sso_link_unavailable'
  | 'sso_unlink_unavailable';

export interface ApiErrorDetail {
  code: ApiErrorCode;
  /**
   * Human-readable English from the server, for logs and as a last-resort
   * fallback. Not stable; switch on `code` instead. Always "internal server
   * error" for a 5xx.
   */
  message: string;
}

/** Body of every API error response: `{"error":{"code":…,"message":…}}`. */
export interface ApiErrorResponse {
  error: ApiErrorDetail;
}
