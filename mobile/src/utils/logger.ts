export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
}

const BUFFER_SIZE = 200;
const buffer: LogEntry[] = new Array(BUFFER_SIZE);
let writeIndex = 0;
let count = 0;

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

function push(level: LogLevel, args: unknown[]): void {
  const msg = args.map(serializeArg).join(' ');
  buffer[writeIndex] = { ts: new Date().toISOString(), level, msg };
  writeIndex = (writeIndex + 1) % BUFFER_SIZE;
  if (count < BUFFER_SIZE) count++;
}

export function getLogs(): LogEntry[] {
  if (count < BUFFER_SIZE) {
    return buffer.slice(0, count);
  }
  // Buffer is full — return in chronological order starting from writeIndex
  return [...buffer.slice(writeIndex), ...buffer.slice(0, writeIndex)];
}

export function clearLogs(): void {
  writeIndex = 0;
  count = 0;
}

let initialized = false;

export function initLogger(): void {
  if (initialized) return;
  initialized = true;

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
}
