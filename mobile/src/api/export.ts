import { getBaseUrl, getStoredSession } from './client';
import { cachePath, deleteFileIfExists, downloadFile, ensureDirExists, listFileNames } from '../utils/fs';

const EXPORT_DIR = cachePath('exports');

/**
 * How long the export download may go without receiving a byte. The server
 * gathers every note before the first byte, and a bundle can run to hundreds
 * of MB, so a fixed total budget either cuts off a big export on a slow link or
 * leaves a dead connection hanging for many minutes. A stall timer covers both.
 *
 * This is an upper bound, not a guarantee: on Android, expo-file-system's
 * downloader uses a default OkHttp client, whose own 10 s read timeout fails a
 * gap longer than that first.
 */
export const EXPORT_STALL_TIMEOUT_MS = 60_000;

/** Hard cap on the whole transfer, matching the server's 30-minute bundle write deadline. */
export const EXPORT_TOTAL_TIMEOUT_MS = 30 * 60_000;

/**
 * Remove bundles a previous export left behind: a shared bundle is kept until
 * the next export, since the receiving app may still be reading it after the
 * share sheet closes (see ExportSection), and a killed app leaves one too.
 */
export function clearExportCache(): void {
  for (const name of listFileNames(EXPORT_DIR)) {
    deleteFileIfExists(`${EXPORT_DIR}/${name}`);
  }
}

/**
 * Download the `GET /notes/export` bundle into the cache directory and return
 * its file URI. Any earlier bundle is cleared first. Rejects on a non-2xx response, a transport error, a timeout, or
 * an abort of `signal`, leaving no partial file behind.
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
