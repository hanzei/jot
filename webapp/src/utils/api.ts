import axios from 'axios';
import { API_BASE_PATH, apiPaths, apiUrl, createJotApi, type FileImportType, type ExportFormat, type ImportResponse, type NoteImage, type User } from '@jot/shared';
import { removeUser } from '@/utils/auth';
import { authPathWithRedirect, currentRedirectTarget } from '@/utils/authRedirect';
import { recordFailedRequest } from '@/utils/diagnostics';

// Unique ID for this browser tab, used to suppress SSE echoes of our own mutations.
export const CLIENT_ID = crypto.randomUUID();

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Reject a 401 without redirecting to /login, for callers that must stay on the page. */
    skipAuthRedirect?: boolean;
  }
}

const api = axios.create({
  baseURL: API_BASE_PATH,
  withCredentials: true,
  timeout: 10_000,
  headers: { 'X-Client-Id': CLIENT_ID },
});

// Record failures for Settings > Diagnostics, and handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    recordFailedRequest(error);
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      // Only the read is exempt: PATCH /users/me must still clear a dead session.
      const isCurrentUserRead = url === apiPaths.usersMe && error.config?.method?.toLowerCase() === 'get';
      const isAuthEndpoint = url === apiPaths.login || url === apiPaths.register || isCurrentUserRead;
      if (!isAuthEndpoint && !error.config?.skipAuthRedirect) {
        const target = currentRedirectTarget();
        removeUser().finally(() => {
          // Full page load, so the target has to survive in the URL rather
          // than in router state.
          window.location.href = authPathWithRedirect('/login', target);
        });
      }
    }
    return Promise.reject(error);
  }
);

// The endpoints themselves live in @jot/shared, shared with mobile. What stays
// here is web-specific: the instance above, multipart bodies built from
// `File`s, the blob download, and URLs the browser loads directly.
const jot = createJotApi(api);

export const { sso, auth, labels, sessions, pats, about, admin, config: serverConfig } = jot;

// OIDC/SSO endpoints. The login and link flows are server-side redirect flows,
// so the browser must do a full-page navigation to these absolute URLs (an
// anchor or `window.location`) — an axios/XHR call would follow the IdP 302 in
// the background and never hand control to the identity provider. Only unlink
// is a plain JSON API call.
export const SSO_LOGIN_URL = apiUrl(apiPaths.oidcLogin);
export const SSO_LINK_URL = apiUrl(apiPaths.oidcLink);

export const notes = {
  ...jot.notes,

  import: (
    payload:
      | { file: File; importType: FileImportType }
      | { importType: 'usememos'; url: string; token: string },
  ): Promise<ImportResponse> => {
    const formData = new FormData();
    formData.append('import_type', payload.importType);
    if (payload.importType === 'usememos') {
      formData.append('url', payload.url);
      formData.append('token', payload.token);
    } else {
      formData.append('file', payload.file);
    }
    return jot.notes.import(formData);
  },

  exportNotes: (format: ExportFormat): Promise<{ blob: Blob; filename: string }> =>
    api.get(apiPaths.notesExport, { params: { format }, responseType: 'blob' }).then(res => {
      const disposition = res.headers['content-disposition'] as string | undefined;
      const match = disposition?.match(/filename="?([^";\r\n]+)"?/);
      const filename = match?.[1] ?? (format === 'markdown' ? 'jot-markdown-export.zip' : 'jot-export.zip');
      return { blob: res.data as Blob, filename };
    }),
};

export const users = {
  ...jot.users,

  uploadProfileIcon: (file: File): Promise<User> => {
    const formData = new FormData();
    formData.append('file', file);
    return jot.users.uploadProfileIcon(formData);
  },
};

// Note images are served inline (not via axios) so <img> tags can use the URL
// directly as their src; the browser sends the session cookie automatically
// for this same-origin request.
export const images = {
  url: (id: string): string => apiUrl(apiPaths.image(id)),

  // Resized JPEG tile for grid/cover thumbnails; the lightbox uses `url`
  // (the original) instead so a closer look never shows a downscaled image.
  thumbnailUrl: (id: string): string => apiUrl(apiPaths.imageThumbnail(id)),

  upload: (noteId: string, file: File, onProgress?: (percent: number) => void): Promise<NoteImage> => {
    const formData = new FormData();
    formData.append('file', file);
    return jot.images.upload(noteId, formData, {
      onUploadProgress: (event: { loaded: number; total?: number }) => {
        if (!onProgress || !event.total) return;
        onProgress(Math.round((event.loaded / event.total) * 100));
      },
    });
  },

  delete: jot.images.delete,
};

export default api;
