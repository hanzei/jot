import type {
  AboutInfo,
  ActiveSession,
  AdminStatsResponse,
  AuthResponse,
  ChangePasswordRequest,
  ConvertNoteTypeRequest,
  CreateNoteItemRequest,
  CreateNoteRequest,
  CreatePATRequest,
  CreateUserRequest,
  EmptyTrashResponse,
  GetNotesParams,
  ImportResponse,
  Label,
  LabelWithCount,
  LabelListResponse,
  LoginRequest,
  Note,
  NoteImage,
  NoteItem,
  NoteListResponse,
  NoteShare,
  NoteShareListResponse,
  PATListResponse,
  PatchNoteItemRequest,
  PersonalAccessToken,
  RegisterRequest,
  ServerConfig,
  SessionListResponse,
  SetUserPasswordRequest,
  ShareNoteRequest,
  UpdateMeRequest,
  UpdateNoteRequest,
  UpdateUserRoleRequest,
  User,
  UserListResponse,
  UserSearchResponse,
} from '../types';
import { apiPaths } from './paths';

/**
 * Per-request options, passed through to the client's HTTP layer untouched.
 * Only `params` is read here; anything else (`signal`, `timeout`,
 * `onUploadProgress`, the webapp's `skipAuthRedirect`, …) is the client's own.
 */
export interface HttpRequestConfig {
  params?: Record<string, unknown>;
  [option: string]: unknown;
}

export interface HttpResponse<T> {
  data: T;
}

/**
 * The slice of an axios instance the endpoint functions use, declared
 * structurally: `shared/` has no runtime dependencies, so each client passes
 * in its own configured axios instance (base URL, auth, interceptors).
 */
export interface JotHttpClient {
  get<T>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  delete<T>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  post<T>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  patch<T>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  put<T>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
}

/** Client-supplied IDs that make a duplicate idempotent under offline replay. */
export interface DuplicateNoteOptions {
  /** ID for the new note. */
  id?: string | undefined;
  /** Source item ID → ID for its copy. */
  itemIds?: Record<string, string> | undefined;
}

/**
 * The REST endpoints, bound to `http`. Every client builds its request from
 * here, so a path, body, or response shape changes in one place.
 *
 * Uploads take a ready-made multipart body: building it (a `File` on the web,
 * a `{ uri, name, type }` part on React Native) stays in each client, as do
 * downloads, which only share their path.
 *
 * `http` is only touched when an endpoint is called, never here, so a test
 * that mocks a client's module without a usable instance still loads.
 */
export function createJotApi(http: JotHttpClient) {
  const data = <T>(request: Promise<HttpResponse<T>>): Promise<T> => request.then(res => res.data);
  const done = (request: Promise<unknown>): Promise<void> => request.then(() => undefined);

  return {
    config: {
      get: (): Promise<ServerConfig> => data(http.get<ServerConfig>(apiPaths.config)),
    },

    about: {
      get: (config?: HttpRequestConfig): Promise<AboutInfo> => data(http.get<AboutInfo>(apiPaths.about, config)),
    },

    auth: {
      login: (body: LoginRequest): Promise<AuthResponse> => data(http.post<AuthResponse>(apiPaths.login, body)),
      register: (body: RegisterRequest): Promise<AuthResponse> => data(http.post<AuthResponse>(apiPaths.register, body)),
      logout: (config?: HttpRequestConfig): Promise<void> => done(http.post(apiPaths.logout, undefined, config)),
      me: (): Promise<AuthResponse> => data(http.get<AuthResponse>(apiPaths.usersMe)),
    },

    sso: {
      unlink: (): Promise<void> => done(http.post(apiPaths.oidcUnlink)),
    },

    notes: {
      // `user_id` is a client-side filter and never sent. An empty label or a
      // false my_tasks is left out rather than sent as `label=`/`my_tasks=false`.
      getAll: (params: GetNotesParams = {}): Promise<Note[]> =>
        http.get<NoteListResponse>(apiPaths.notes, {
          params: {
            archived: params.archived,
            search: params.search,
            trashed: params.trashed,
            label: params.label || undefined,
            my_tasks: params.my_tasks || undefined,
          },
        }).then(res => res.data.notes),

      getById: (id: string): Promise<Note> => data(http.get<Note>(apiPaths.note(id))),

      create: (body: CreateNoteRequest): Promise<Note> => data(http.post<Note>(apiPaths.notes, body)),

      update: (id: string, body: UpdateNoteRequest): Promise<Note> => data(http.patch<Note>(apiPaths.note(id), body)),

      // The same URL the sync queue stores for an offline permanent delete.
      delete: (id: string, opts?: { permanent?: boolean }): Promise<void> =>
        done(http.delete(opts?.permanent ? apiPaths.notePermanentDelete(id) : apiPaths.note(id))),

      emptyTrash: (): Promise<EmptyTrashResponse> => data(http.delete<EmptyTrashResponse>(apiPaths.notesTrash)),

      restore: (id: string): Promise<Note> => data(http.post<Note>(apiPaths.noteRestore(id))),

      markViewed: (id: string): Promise<void> => done(http.post(apiPaths.noteViewed(id))),

      // Without client IDs the request has no body, as before IDs existed.
      duplicate: (id: string, opts: DuplicateNoteOptions = {}): Promise<Note> => {
        const body: { id?: string; item_ids?: Record<string, string> } = {};
        if (opts.id) body.id = opts.id;
        if (opts.itemIds) body.item_ids = opts.itemIds;
        return data(http.post<Note>(apiPaths.noteDuplicate(id), Object.keys(body).length ? body : undefined));
      },

      convert: (id: string, body: ConvertNoteTypeRequest): Promise<Note> => data(http.post<Note>(apiPaths.noteConvert(id), body)),

      share: (id: string, body: ShareNoteRequest): Promise<void> => done(http.post(apiPaths.noteShare(id), body)),

      unshare: (id: string, userId: string): Promise<void> => done(http.delete(apiPaths.noteShareUser(id, userId))),

      getShares: (id: string): Promise<NoteShare[]> =>
        http.get<NoteShareListResponse>(apiPaths.noteShares(id)).then(res => res.data.shares),

      reorder: (noteIds: string[]): Promise<void> => done(http.post(apiPaths.notesReorder, { note_ids: noteIds })),

      /** `formData` carries `import_type` plus either `file` or the usememos `url`/`token`. */
      import: (formData: unknown, config?: HttpRequestConfig): Promise<ImportResponse> =>
        data(http.post<ImportResponse>(apiPaths.notesImport, formData, config)),

      addLabel: (noteId: string, name: string): Promise<Note> => data(http.post<Note>(apiPaths.noteLabels(noteId), { name })),

      removeLabel: (noteId: string, labelId: string): Promise<Note> => data(http.delete<Note>(apiPaths.noteLabel(noteId, labelId))),

      // Granular list-item operations. Editing items one at a time (rather than
      // replacing the whole array) lets concurrent edits to a shared list merge
      // server-side instead of overwriting each other.
      createItem: (noteId: string, body: CreateNoteItemRequest): Promise<NoteItem> =>
        data(http.post<NoteItem>(apiPaths.noteItems(noteId), body)),

      updateItem: (noteId: string, itemId: string, body: PatchNoteItemRequest): Promise<NoteItem> =>
        data(http.patch<NoteItem>(apiPaths.noteItem(noteId, itemId), body)),

      deleteItem: (noteId: string, itemId: string): Promise<void> => done(http.delete(apiPaths.noteItem(noteId, itemId))),

      reorderItems: (noteId: string, itemIds: string[]): Promise<void> =>
        done(http.post(apiPaths.noteItemsReorder(noteId), { item_ids: itemIds })),

      // Set-completed is the one path for a single tap ([itemId]) and for bulk
      // actions over an explicit set of item IDs. Each call is one atomic server
      // request (rather than a per-item burst) that applies the parent/child
      // cascade — checking a top-level item carries to its children, unchecking a
      // child unchecks its parent — and returns the note's full item list for the
      // caller to reconcile from a single response. Callers pass the exact set they
      // captured, so an item toggled after the click is never affected.
      setItemsCompleted: (noteId: string, itemIds: string[], completed: boolean): Promise<NoteItem[]> =>
        data(http.post<NoteItem[]>(apiPaths.noteItemsSetCompleted(noteId), { item_ids: itemIds, completed })),

      deleteItems: (noteId: string, itemIds: string[]): Promise<NoteItem[]> =>
        data(http.post<NoteItem[]>(apiPaths.noteItemsDelete(noteId), { item_ids: itemIds })),
    },

    labels: {
      /** Every label, each with its `note_count`. */
      getAll: (): Promise<LabelWithCount[]> => http.get<LabelListResponse>(apiPaths.labels).then(res => res.data.labels),

      create: (name: string): Promise<Label> => data(http.post<Label>(apiPaths.labels, { name })),

      rename: (id: string, name: string): Promise<Label> => data(http.patch<Label>(apiPaths.label(id), { name })),

      delete: (id: string): Promise<void> => done(http.delete(apiPaths.label(id))),
    },

    users: {
      /**
       * Every user but the caller. Without a search term the server does not cap
       * the list, which share pickers and avatar lookups rely on.
       */
      list: (): Promise<User[]> => http.get<UserSearchResponse>(apiPaths.users).then(res => res.data.users),

      /** At most 50 matches; `truncated` is set when more users matched the query. */
      search: (query: string): Promise<UserSearchResponse> =>
        data(http.get<UserSearchResponse>(apiPaths.users, { params: { search: query } })),

      updateMe: (body: UpdateMeRequest): Promise<AuthResponse> => data(http.patch<AuthResponse>(apiPaths.usersMe, body)),

      changePassword: (body: ChangePasswordRequest): Promise<void> => done(http.put(apiPaths.usersMePassword, body)),

      /** `formData` carries the image as `file`. */
      uploadProfileIcon: (formData: unknown, config?: HttpRequestConfig): Promise<User> =>
        data(http.post<User>(apiPaths.usersMeProfileIcon, formData, config)),

      deleteProfileIcon: (): Promise<void> => done(http.delete(apiPaths.usersMeProfileIcon)),
    },

    sessions: {
      list: (): Promise<ActiveSession[]> => http.get<SessionListResponse>(apiPaths.sessions).then(res => res.data.sessions),

      revoke: (id: string): Promise<void> => done(http.delete(apiPaths.session(id))),
    },

    pats: {
      list: (): Promise<PersonalAccessToken[]> => http.get<PATListResponse>(apiPaths.pats).then(res => res.data.pats),

      create: (body: CreatePATRequest): Promise<PersonalAccessToken> => data(http.post<PersonalAccessToken>(apiPaths.pats, body)),

      revoke: (id: string): Promise<void> => done(http.delete(apiPaths.pat(id))),
    },

    images: {
      /** `formData` carries the image as `file`. */
      upload: (noteId: string, formData: unknown, config?: HttpRequestConfig): Promise<NoteImage> =>
        data(http.post<NoteImage>(apiPaths.noteImages(noteId), formData, config)),

      delete: (id: string): Promise<void> => done(http.delete(apiPaths.image(id))),
    },

    admin: {
      getStats: (): Promise<AdminStatsResponse> => data(http.get<AdminStatsResponse>(apiPaths.adminStats)),

      getUsers: (): Promise<UserListResponse> => data(http.get<UserListResponse>(apiPaths.adminUsers)),

      createUser: (body: CreateUserRequest): Promise<User> => data(http.post<User>(apiPaths.adminUsers, body)),

      updateUserRole: (id: string, body: UpdateUserRoleRequest): Promise<User> =>
        data(http.put<User>(apiPaths.adminUserRole(id), body)),

      setUserPassword: (id: string, body: SetUserPasswordRequest): Promise<void> =>
        done(http.put(apiPaths.adminUserPassword(id), body)),

      deleteUser: (id: string): Promise<void> => done(http.delete(apiPaths.adminUser(id))),
    },
  };
}

export type JotApi = ReturnType<typeof createJotApi>;
