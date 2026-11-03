import type { AxiosProgressEvent } from 'axios';
import { Platform } from 'react-native';

/**
 * A React Native multipart file part. iOS wants a bare path, not a
 * `file://` URI; Android keeps its URI (often `content://`) as-is.
 */
export function rnFilePart(uri: string, name: string, type: string): Blob {
  return {
    uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
    name,
    type,
  } as unknown as Blob;
}

/**
 * The axios `onUploadProgress` option reporting whole percentages, each only
 * once; spread it into the request config. Without `onPercent`, nothing.
 */
export function percentProgress(
  onPercent?: (percent: number) => void,
): { onUploadProgress?: (event: AxiosProgressEvent) => void } {
  if (!onPercent) return {};
  let lastPercent = -1;
  return {
    onUploadProgress: (event) => {
      const percent = event.total ? Math.round((event.loaded * 100) / event.total) : 0;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onPercent(percent);
      }
    },
  };
}
