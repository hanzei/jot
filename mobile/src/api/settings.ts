import { Platform } from 'react-native';
import type { AxiosProgressEvent } from 'axios';
import { jot } from './jot';
import type { User } from '@jot/shared';

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

