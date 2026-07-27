import { AppState } from 'react-native';
import {
  appendTextFile,
  deleteFileIfExists,
  documentPath,
  ensureDirExists,
  fileSize,
  moveFileSync,
  readTextFile,
} from './fs';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
}

const BUFFER_SIZE = 1000;
const buffer: LogEntry[] = new Array(BUFFER_SIZE);
let writeIndex = 0;
let count = 0;

// ── Persistence ──────────────────────────────────────────────────────────────
//
// The ring buffer above only covers the current process, so the logs from the
// session that actually went wrong are gone by the time a user opens
// Diagnostics after a restart. Entries are therefore also appended to a JSONL
// file under the document directory (durable — the OS will not reclaim it).
//
// Retention is purely size-based: the active file is rotated once it exceeds
// MAX_LOG_FILE_BYTES, and exactly one rotated generation is kept, so the logs
// occupy at most 2 × MAX_LOG_FILE_BYTES on disk. There is deliberately no
// age-based expiry — a quiet install keeps its history until new entries push
// it out.

const LOG_DIR = documentPath('logs');
const CURRENT_LOG_FILE = `${LOG_DIR}/jot.jsonl`;
const PREVIOUS_LOG_FILE = `${LOG_DIR}/jot.1.jsonl`;

const MAX_LOG_FILE_BYTES = 256 * 1024;
/** Cap on entries returned by {@link getPersistedLogs} so the log screen can't be handed an unbounded list. */
const MAX_PERSISTED_ENTRIES = 2000;
const FLUSH_INTERVAL_MS = 2000;
/** Flush early when a burst (e.g. a retry storm) fills the pending batch before the timer fires. */
const MAX_PENDING_ENTRIES = 200;
/** Give up on file persistence after this many consecutive failures, keeping the in-memory buffer working. */
const MAX_FLUSH_FAILURES = 3;

let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceEnabled = false;
let flushFailures = 0;

function serializeArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Move the active log file aside, discarding the older generation. Called from
 * {@link flushLogs} once the active file outgrows MAX_LOG_FILE_BYTES.
 */
function rotate(): void {
  deleteFileIfExists(PREVIOUS_LOG_FILE);
  moveFileSync(CURRENT_LOG_FILE, PREVIOUS_LOG_FILE);
}

/**
 * Write any batched entries to disk. Synchronous throughout, so a rotation can
 * never interleave with an append.
 *
 * Never logs on failure: every `console.*` call routes back into {@link push},
 * so reporting a flush error through the console would recurse. Instead,
 * repeated failures disable persistence and leave the in-memory buffer intact.
 */
export function flushLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!persistenceEnabled || pending.length === 0) {
    return;
  }

  const batch = pending;
  pending = [];
  try {
    ensureDirExists(LOG_DIR);
    if (fileSize(CURRENT_LOG_FILE) >= MAX_LOG_FILE_BYTES) {
      rotate();
    }
    appendTextFile(CURRENT_LOG_FILE, `${batch.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    flushFailures = 0;
  } catch {
    flushFailures += 1;
    if (flushFailures >= MAX_FLUSH_FAILURES) {
      persistenceEnabled = false;
    }
  }
}

function scheduleFlush(): void {
  if (!persistenceEnabled) {
    return;
  }
  if (pending.length >= MAX_PENDING_ENTRIES) {
    flushLogs();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
  }
}

function push(level: LogLevel, args: unknown[]): void {
  const msg = args.map(serializeArg).join(' ');
  const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
  buffer[writeIndex] = entry;
  writeIndex = (writeIndex + 1) % BUFFER_SIZE;
  if (count < BUFFER_SIZE) count++;

  if (persistenceEnabled) {
    pending.push(entry);
    scheduleFlush();
  }
}

/** Entries captured during the current process only, oldest first. */
export function getLogs(): LogEntry[] {
  if (count < BUFFER_SIZE) {
    return buffer.slice(0, count);
  }
  // Buffer is full — return in chronological order starting from writeIndex
  return [...buffer.slice(writeIndex), ...buffer.slice(0, writeIndex)];
}

function parseLogFile(uri: string): LogEntry[] {
  const contents = readTextFile(uri);
  if (!contents) {
    return [];
  }
  const entries: LogEntry[] = [];
  for (const line of contents.split('\n')) {
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as LogEntry).ts === 'string' &&
        typeof (parsed as LogEntry).msg === 'string'
      ) {
        entries.push(parsed as LogEntry);
      }
    } catch {
      // A torn final line (process died mid-write) — skip it and keep the rest.
    }
  }
  return entries;
}

/**
 * Entries persisted across sessions, oldest first, capped at
 * MAX_PERSISTED_ENTRIES. Flushes first so the current session is included.
 * Falls back to the in-memory buffer when persistence is unavailable.
 */
export function getPersistedLogs(): LogEntry[] {
  flushLogs();
  if (!persistenceEnabled) {
    return getLogs();
  }
  const entries = [...parseLogFile(PREVIOUS_LOG_FILE), ...parseLogFile(CURRENT_LOG_FILE)];
  return entries.length > MAX_PERSISTED_ENTRIES ? entries.slice(-MAX_PERSISTED_ENTRIES) : entries;
}

/** Clear the in-memory buffer and every persisted entry. */
export function clearLogs(): void {
  writeIndex = 0;
  count = 0;
  pending = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  deleteFileIfExists(CURRENT_LOG_FILE);
  deleteFileIfExists(PREVIOUS_LOG_FILE);
}

let initialized = false;

export function initLogger(): void {
  if (initialized) return;
  initialized = true;

  try {
    ensureDirExists(LOG_DIR);
    persistenceEnabled = true;
  } catch {
    // No durable storage (e.g. tests, or an unwritable document directory) —
    // carry on with the in-memory buffer alone.
    persistenceEnabled = false;
  }

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const origInfo = console.info.bind(console);

  console.warn = (...args: unknown[]) => {
    push('warn', args);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    push('error', args);
    origError(...args);
  };
  console.info = (...args: unknown[]) => {
    push('info', args);
    origInfo(...args);
  };

  // A backgrounded app can be killed without further warning, so drain the
  // batch on the way out rather than losing up to FLUSH_INTERVAL_MS of entries.
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      flushLogs();
    }
  });
}
