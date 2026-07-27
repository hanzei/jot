import { initLogger, getLogs, getPersistedLogs, clearLogs, flushLogs, LogEntry } from '../src/utils/logger';

const fs = globalThis.mockFileSystem;

const CURRENT_LOG_FILE = 'file:///docs/logs/jot.jsonl';
const PREVIOUS_LOG_FILE = 'file:///docs/logs/jot.1.jsonl';

// Capture the original console methods before initLogger replaces them
const origWarn = console.warn;
const origError = console.error;
const origInfo = console.info;

beforeAll(() => {
  initLogger();
});

afterAll(() => {
  // Drops any armed flush timer so Jest's worker can exit cleanly.
  clearLogs();
  console.warn = origWarn;
  console.error = origError;
  console.info = origInfo;
});

beforeEach(() => {
  clearLogs();
  fs.reset();
});

describe('initLogger', () => {
  it('is idempotent — calling it twice does not double-wrap interceptors', () => {
    initLogger();
    console.warn('test');
    // If interceptors were double-wrapped, one warn call would produce two log entries
    expect(getLogs()).toHaveLength(1);
  });
});

describe('log capture', () => {
  it('captures console.warn with level "warn"', () => {
    console.warn('warn message');
    const logs = getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('warn');
    expect(logs[0].msg).toContain('warn message');
  });

  it('captures console.error with level "error"', () => {
    console.error('error message');
    const logs = getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('error');
    expect(logs[0].msg).toContain('error message');
  });

  it('captures console.info with level "info"', () => {
    console.info('info message');
    const logs = getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(logs[0].msg).toContain('info message');
  });

  it('each entry has ts, level, and msg fields', () => {
    console.warn('check fields');
    const entry: LogEntry = getLogs()[0];
    expect(typeof entry.ts).toBe('string');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(['info', 'warn', 'error']).toContain(entry.level);
    expect(typeof entry.msg).toBe('string');
  });

  it('serializes non-string arguments', () => {
    console.warn('prefix', { key: 'value' }, 42);
    const logs = getLogs();
    expect(logs[0].msg).toContain('prefix');
    expect(logs[0].msg).toContain('"key"');
    expect(logs[0].msg).toContain('42');
  });

  it('captures multiple entries in order', () => {
    console.warn('first');
    console.error('second');
    console.info('third');
    const logs = getLogs();
    expect(logs).toHaveLength(3);
    expect(logs[0].msg).toBe('first');
    expect(logs[1].msg).toBe('second');
    expect(logs[2].msg).toBe('third');
  });
});

describe('clearLogs', () => {
  it('empties the buffer', () => {
    console.warn('a');
    console.warn('b');
    clearLogs();
    expect(getLogs()).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('writes captured entries to the log file on flush', () => {
    console.warn('persisted message');
    flushLogs();

    const contents = fs.files.get(CURRENT_LOG_FILE) ?? '';
    expect(contents).toContain('persisted message');
    // One JSONL record per entry, newline-terminated.
    expect(contents.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(contents.trimEnd())).toMatchObject({ level: 'warn', msg: 'persisted message' });
  });

  it('batches entries rather than writing on every console call', () => {
    console.warn('one');
    console.warn('two');
    expect(fs.files.has(CURRENT_LOG_FILE)).toBe(false);

    flushLogs();

    expect((fs.files.get(CURRENT_LOG_FILE) ?? '').trimEnd().split('\n')).toHaveLength(2);
  });

  it('survives a simulated restart — getPersistedLogs returns entries the ring buffer lost', () => {
    console.error('from the previous session');
    flushLogs();
    // Wipe the in-memory buffer only, as a fresh process would start with.
    const persisted = getPersistedLogs();
    expect(persisted.map((e) => e.msg)).toContain('from the previous session');
  });

  it('reads the rotated generation as well as the active one, oldest first', () => {
    fs.dirs.add('file:///docs/logs');
    fs.files.set(PREVIOUS_LOG_FILE, `${JSON.stringify({ ts: '2024-01-01T00:00:00Z', level: 'warn', msg: 'older' })}\n`);
    fs.files.set(CURRENT_LOG_FILE, `${JSON.stringify({ ts: '2024-01-02T00:00:00Z', level: 'warn', msg: 'newer' })}\n`);

    expect(getPersistedLogs().map((e) => e.msg)).toEqual(['older', 'newer']);
  });

  it('skips a torn final line left by a process that died mid-write', () => {
    fs.dirs.add('file:///docs/logs');
    fs.files.set(
      CURRENT_LOG_FILE,
      `${JSON.stringify({ ts: '2024-01-01T00:00:00Z', level: 'warn', msg: 'intact' })}\n{"ts":"2024-01-0`,
    );

    expect(getPersistedLogs().map((e) => e.msg)).toEqual(['intact']);
  });

  it('rotates once the active file exceeds the size cap, keeping one generation', () => {
    // Fill the active file past the 256 KiB cap.
    fs.dirs.add('file:///docs/logs');
    fs.files.set(CURRENT_LOG_FILE, 'x'.repeat(256 * 1024 + 1));

    console.warn('after rotation');
    flushLogs();

    // The oversized contents moved aside; the active file restarted.
    expect(fs.files.get(PREVIOUS_LOG_FILE)).toHaveLength(256 * 1024 + 1);
    expect(fs.files.get(CURRENT_LOG_FILE)).toContain('after rotation');
    expect((fs.files.get(CURRENT_LOG_FILE) ?? '').length).toBeLessThan(1024);
  });

  it('discards the older generation on a second rotation, so at most two files exist', () => {
    fs.dirs.add('file:///docs/logs');
    fs.files.set(PREVIOUS_LOG_FILE, 'first-generation');
    fs.files.set(CURRENT_LOG_FILE, 'x'.repeat(256 * 1024 + 1));

    console.warn('after second rotation');
    flushLogs();

    expect(fs.files.get(PREVIOUS_LOG_FILE)).not.toBe('first-generation');
    const logFiles = [...fs.files.keys()].filter((uri) => uri.startsWith('file:///docs/logs/'));
    expect(logFiles).toHaveLength(2);
  });

  it('clearLogs removes both the active and rotated files', () => {
    fs.dirs.add('file:///docs/logs');
    fs.files.set(PREVIOUS_LOG_FILE, 'old');
    console.warn('current');
    flushLogs();

    clearLogs();

    expect(fs.files.has(CURRENT_LOG_FILE)).toBe(false);
    expect(fs.files.has(PREVIOUS_LOG_FILE)).toBe(false);
    expect(getPersistedLogs()).toHaveLength(0);
  });
});

describe('ring buffer behaviour', () => {
  it('stores up to 1000 entries', () => {
    for (let i = 0; i < 1000; i++) {
      console.warn(`msg-${i}`);
    }
    expect(getLogs()).toHaveLength(1000);
  });

  it('evicts the oldest entry when the buffer is full', () => {
    for (let i = 0; i < 1005; i++) {
      console.warn(`msg-${i}`);
    }
    const logs = getLogs();
    expect(logs).toHaveLength(1000);
    // The first 5 messages (msg-0 through msg-4) should be gone
    expect(logs[0].msg).toBe('msg-5');
    expect(logs[999].msg).toBe('msg-1004');
  });

  it('returns entries in chronological order after wrap-around', () => {
    for (let i = 0; i < 1010; i++) {
      console.warn(`msg-${i}`);
    }
    const logs = getLogs();
    for (let i = 0; i < logs.length - 1; i++) {
      expect(logs[i].ts <= logs[i + 1].ts).toBe(true);
    }
  });
});
