const STORAGE_KEY = 'jot_pending_deep_link';

// Backs the SecureStore mock with a real map so the store's own
// read/write/parse logic runs. Both live at module scope in this file, which
// jest.resetModules() does not touch — so re-requiring the store gives it an
// empty in-memory cache while the "device storage" persists, which is exactly
// the app being killed and relaunched.
const mockStorage = new Map<string, string>();
const mockFailures = { read: false, write: false };
// When set, writes block on this promise — used to hold a write open across a
// concurrent clear.
const mockGates: { write: Promise<void> | null } = { write: null };

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) =>
    mockFailures.read
      ? Promise.reject(new Error('read failed'))
      : Promise.resolve(mockStorage.get(key) ?? null),
  ),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    if (mockGates.write) {
      await mockGates.write;
    }
    if (mockFailures.write) {
      throw new Error('write failed');
    }
    mockStorage.set(key, value);
  }),
  deleteItemAsync: jest.fn((key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  }),
}));

type PendingDeepLinkStore = typeof import('../src/store/pendingDeepLink');

function loadStore(): PendingDeepLinkStore {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/store/pendingDeepLink') as PendingDeepLinkStore;
}

// The store as this process sees it. `loadStore()` again to simulate a restart.
let store: PendingDeepLinkStore;

function seedStorage(entry: unknown): void {
  mockStorage.set(STORAGE_KEY, JSON.stringify(entry));
}

describe('pendingDeepLink', () => {
  beforeEach(() => {
    mockStorage.clear();
    mockFailures.read = false;
    mockFailures.write = false;
    mockGates.write = null;
    store = loadStore();
  });

  it('returns null when nothing is stashed', async () => {
    await expect(store.getPendingDeepLink()).resolves.toBeNull();
  });

  it('returns a stashed link', async () => {
    await store.setPendingDeepLink('jot://notes/abc123');
    await expect(store.getPendingDeepLink()).resolves.toBe('jot://notes/abc123');
  });

  it('survives a restart between the tap and sign-in', async () => {
    const url = 'jot://notes/abc123?server=https://jot.example.com';
    await store.setPendingDeepLink(url);

    const relaunched = loadStore();

    await expect(relaunched.getPendingDeepLink()).resolves.toBe(url);
  });

  it('discards a link older than the TTL', async () => {
    seedStorage({
      url: 'jot://notes/abc123',
      stashedAt: Date.now() - store.PENDING_DEEP_LINK_TTL_MS - 1,
    });

    const relaunched = loadStore();

    await expect(relaunched.getPendingDeepLink()).resolves.toBeNull();
    // Expired values are purged rather than re-read on the next call.
    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
  });

  it('discards a link stamped in the future', async () => {
    // A clock corrected backwards after the stash: the age goes negative, and
    // a bare "age > TTL" check would keep the link alive for the whole drift.
    seedStorage({ url: 'jot://notes/abc123', stashedAt: Date.now() + 60 * 60 * 1000 });

    const relaunched = loadStore();

    await expect(relaunched.getPendingDeepLink()).resolves.toBeNull();
    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
  });

  it('keeps a link that is still inside the TTL', async () => {
    seedStorage({
      url: 'jot://notes/abc123',
      stashedAt: Date.now() - (store.PENDING_DEEP_LINK_TTL_MS - 1000),
    });

    const relaunched = loadStore();

    await expect(relaunched.getPendingDeepLink()).resolves.toBe('jot://notes/abc123');
  });

  it('clears the stashed link, including from storage', async () => {
    await store.setPendingDeepLink('jot://notes/abc123');
    await store.clearPendingDeepLink();

    await expect(store.getPendingDeepLink()).resolves.toBeNull();
    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
    await expect(loadStore().getPendingDeepLink()).resolves.toBeNull();
  });

  it('does not let a slow write resurrect a link cleared on logout', async () => {
    let releaseWrite!: () => void;
    mockGates.write = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    // The link is stashed and its write stalls on the native bridge; the user
    // logs out before it lands.
    const stashed = store.setPendingDeepLink('jot://notes/abc123');
    const clearedOnLogout = store.clearPendingDeepLink();

    releaseWrite();
    await Promise.all([stashed, clearedOnLogout]);

    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
    await expect(store.getPendingDeepLink()).resolves.toBeNull();
    await expect(loadStore().getPendingDeepLink()).resolves.toBeNull();
  });

  it('consumes the replayed link', async () => {
    await store.setPendingDeepLink('jot://notes/abc123');

    await store.consumePendingDeepLink('jot://notes/abc123');

    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
    await expect(store.getPendingDeepLink()).resolves.toBeNull();
  });

  it('leaves a newer link stashed when consuming an older one', async () => {
    // A second deep link arrives (and is stashed by the server-switch path)
    // while the first is still being replayed.
    await store.setPendingDeepLink('jot://notes/first');
    await store.setPendingDeepLink('jot://notes/second');

    await store.consumePendingDeepLink('jot://notes/first');

    await expect(store.getPendingDeepLink()).resolves.toBe('jot://notes/second');
    await expect(loadStore().getPendingDeepLink()).resolves.toBe('jot://notes/second');
  });

  it('does not replay a persisted non-protected path', async () => {
    seedStorage({ url: 'jot://labels/work', stashedAt: Date.now() });

    const relaunched = loadStore();

    await expect(relaunched.getPendingDeepLink()).resolves.toBeNull();
    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
  });

  it('does not replay a persisted non-jot URL', async () => {
    seedStorage({ url: 'https://example.com/notes/abc', stashedAt: Date.now() });

    await expect(loadStore().getPendingDeepLink()).resolves.toBeNull();
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['a non-object payload', '"jot://notes/abc123"'],
    ['a missing timestamp', JSON.stringify({ url: 'jot://notes/abc123' })],
    ['a non-numeric timestamp', JSON.stringify({ url: 'jot://notes/abc123', stashedAt: 'now' })],
  ])('ignores %s in storage', async (_label, raw) => {
    mockStorage.set(STORAGE_KEY, raw);

    await expect(loadStore().getPendingDeepLink()).resolves.toBeNull();
  });

  it('still stashes for this session when the write fails', async () => {
    mockFailures.write = true;

    await expect(store.setPendingDeepLink('jot://notes/abc123')).resolves.toBeUndefined();
    await expect(store.getPendingDeepLink()).resolves.toBe('jot://notes/abc123');
    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
  });

  it('returns null when the read fails', async () => {
    seedStorage({ url: 'jot://notes/abc123', stashedAt: Date.now() });
    const relaunched = loadStore();
    mockFailures.read = true;

    await expect(relaunched.getPendingDeepLink()).resolves.toBeNull();
  });
});
