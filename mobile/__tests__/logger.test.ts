import { initLogger, getLogs, clearLogs, LogEntry } from '../src/utils/logger';

// Capture the original console methods before initLogger replaces them
const origWarn = console.warn;
const origError = console.error;
const origInfo = console.info;

beforeAll(() => {
  initLogger();
});

afterAll(() => {
  console.warn = origWarn;
  console.error = origError;
  console.info = origInfo;
});

beforeEach(() => {
  clearLogs();
});

describe('initLogger', () => {
  it('is idempotent — calling it twice does not double-wrap interceptors', () => {
    const warnSpy = jest.spyOn(console, 'warn');
    initLogger();
    console.warn('test');
    // Should only call the spy once, not twice
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
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

describe('ring buffer behaviour', () => {
  it('stores up to 200 entries', () => {
    for (let i = 0; i < 200; i++) {
      console.warn(`msg-${i}`);
    }
    expect(getLogs()).toHaveLength(200);
  });

  it('evicts the oldest entry when the buffer is full', () => {
    for (let i = 0; i < 205; i++) {
      console.warn(`msg-${i}`);
    }
    const logs = getLogs();
    expect(logs).toHaveLength(200);
    // The first 5 messages (msg-0 through msg-4) should be gone
    expect(logs[0].msg).toBe('msg-5');
    expect(logs[199].msg).toBe('msg-204');
  });

  it('returns entries in chronological order after wrap-around', () => {
    for (let i = 0; i < 210; i++) {
      console.warn(`msg-${i}`);
    }
    const logs = getLogs();
    for (let i = 0; i < logs.length - 1; i++) {
      expect(logs[i].ts <= logs[i + 1].ts).toBe(true);
    }
  });
});
