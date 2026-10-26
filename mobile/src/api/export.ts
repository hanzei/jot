import { getBaseUrl, getStoredSession } from './client';
import { cachePath, deleteFileIfExists, downloadFile, ensureDirExists, listFileNames } from '../utils/fs';

const EXPORT_DIR = cachePath('exports');

/**
 * How long the export may go without receiving a byte. A stall timer, rather
 * than a total budget, lets a large bundle finish on a slow link. On Android
 * the native downloader's own 10 s read timeout fails a long gap first.
 */
export const EXPORT_STALL_TIMEOUT_MS = 60_000;

/** Hard cap on the whole transfer, matching the server's 30-minute bundle write deadline. */
export const EXPORT_TOTAL_TIMEOUT_MS = 30 * 60_000;

/**
 * Remove bundles a previous export left behind. A shared bundle is kept until
 * the next export because on Android shareAsync resolves when the chooser
 * returns, possibly before the picked app (Drive uploading in the background,
 * say) has read the file; a killed app leaves one too.
 */
export function clearExportCache(): void {
  for (const name of listFileNames(EXPORT_DIR)) {
    deleteFileIfExists(`${EXPORT_DIR}/${name}`);
  }
}

/**
 * Download the `GET /notes/export` bundle into the cache directory and return
 * its file URI. Any earlier bundle is cleared first. Rejects on a non-2xx
 * response, a transport error, a timeout, or an abort of `signal`, leaving no
 * partial file behind.
 */
export async function downloadExportBundle(signal?: AbortSignal): Promise<string> {
  clearExportCache();
  ensureDirExists(EXPORT_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destUri = `${EXPORT_DIR}/jot-export-${stamp}.zip`;

  const token = await getStoredSession();
  const headers: Record<string, string> = token ? { Cookie: `jot_session=${token}` } : {};

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(abort, EXPORT_STALL_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(abort, EXPORT_TOTAL_TIMEOUT_MS);
  armStallTimer();

  try {
    await downloadFile(`${getBaseUrl()}/api/v1/notes/export`, destUri, {
      headers,
      signal: controller.signal,
      onProgress: armStallTimer,
    });
    return destUri;
  } catch (err) {
    deleteFileIfExists(destUri);
    throw err;
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', abort);
  }
}
