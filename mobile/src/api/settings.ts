import { Platform } from 'react-native';
import type { AxiosProgressEvent } from 'axios';
import { jot } from './jot';
import type { User, AuthResponse, UpdateMeRequest, ChangePasswordRequest, AboutInfo, ActiveSession, PersonalAccessToken, CreatePATRequest } from '@jot/shared';

export async function updateMe(data: UpdateMeRequest): Promise<AuthResponse> {
  return jot.users.updateMe(data);
}

export async function changePassword(data: ChangePasswordRequest): Promise<void> {
  return jot.users.changePassword(data);
}

// Profile-icon uploads can be large on slow cellular, so this is generous —
// but a half-open / unreachable server must still resolve to an error instead
// of hanging forever (issue #695), so it is finite rather than disabled.
export const UPLOAD_ICON_TIMEOUT = 90000;

export async function uploadProfileIcon(
  uri: string,
  onUploadProgress?: (percent: number) => void,
): Promise<User> {
  const formData = new FormData();
  const filename = uri.split('/').pop() || 'photo.jpg';
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpeg';
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const type = mimeMap[ext] || 'image/jpeg';

  formData.append('file', {
    uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
    name: filename,
    type,
  } as unknown as Blob);

  let lastPercent = -1;
  return jot.users.uploadProfileIcon(formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: UPLOAD_ICON_TIMEOUT,
    ...(onUploadProgress && {
      onUploadProgress: (progressEvent: AxiosProgressEvent) => {
        const percent = progressEvent.total
          ? Math.round((progressEvent.loaded * 100) / progressEvent.total)
          : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          onUploadProgress(percent);
        }
      },
    }),
  });
}

export async function deleteProfileIcon(): Promise<void> {
  return jot.users.deleteProfileIcon();
}

export async function getAboutInfo(): Promise<AboutInfo> {
  return jot.about.get();
}

export async function listSessions(): Promise<ActiveSession[]> {
  return jot.sessions.list();
}

export async function revokeSession(id: string): Promise<void> {
  return jot.sessions.revoke(id);
}

export async function listPATs(): Promise<PersonalAccessToken[]> {
  return jot.pats.list();
}

export async function createPAT(data: CreatePATRequest): Promise<PersonalAccessToken> {
  return jot.pats.create(data);
}

export async function revokePAT(id: string): Promise<void> {
  return jot.pats.revoke(id);
}
