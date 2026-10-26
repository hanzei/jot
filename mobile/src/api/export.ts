import type { ExportFormat } from '@jot/shared';
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
 * How long a bundle is kept after its export. On Android shareAsync resolves
 * when the chooser returns, possibly before the picked app (Drive uploading in
 * the background, say) has read the file, so a shared bundle cannot be deleted
 * then — nor by an export started straight after it.
 */
export const EXPORT_BUNDLE_RETENTION_MS = 60 * 60_000;

/**
 * A bundle's name carries its format and creation time:
 * `jot-export-<ISO with : and . as ->.zip`, or `jot-markdown-export-…` for a
 * Markdown export.
 */
function bundleName(format: ExportFormat, createdAt: Date): string {
  const prefix = format === 'markdown' ? 'jot-markdown-export' : 'jot-export';
  return `${prefix}-${createdAt.toISOString().replace(/[:.]/g, '-')}.zip`;
}

/** The creation time encoded by {@link bundleName}, or null for any other name. */
function bundleCreatedAt(name: string): number | null {
  const m = /^jot-(?:markdown-)?export-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$/.exec(name);
  if (!m) return null;
  const time = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(time) ? null : time;
}

/**
 * Remove bundles earlier exports left behind once they are past
 * {@link EXPORT_BUNDLE_RETENTION_MS} (or unrecognized). They are large, so they
 * shouldn't wait for the OS to purge the cache.
 */
export function clearExportCache(now: number = Date.now()): void {
  for (const name of listFileNames(EXPORT_DIR)) {
    const createdAt = bundleCreatedAt(name);
    if (createdAt === null || now - createdAt >= EXPORT_BUNDLE_RETENTION_MS) {
      deleteFileIfExists(`${EXPORT_DIR}/${name}`);
    }
  }
}

/**
 * Download the `GET /notes/export` bundle in `format` into the cache directory and return
 * its file URI. Expired bundles are cleared first. Rejects on a non-2xx
 * response, a transport error, a timeout, or an abort of `signal`, leaving no
 * partial file behind.
 */
export async function downloadExportBundle(format: ExportFormat = 'jot', signal?: AbortSignal): Promise<string> {
  const now = new Date();
  clearExportCache(now.getTime());
  ensureDirExists(EXPORT_DIR);
  const destUri = `${EXPORT_DIR}/${bundleName(format, now)}`;

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
    await downloadFile(`${getBaseUrl()}/api/v1/notes/export?format=${format}`, destUri, {
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
