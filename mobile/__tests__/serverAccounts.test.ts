import * as SecureStore from 'expo-secure-store';
import {
  addServer,
  ensureServerRegistryMigrated,
  getActiveServer,
  getServerScopedStorageKey,
  getServerStorageValue,
  listServers,
  switchServer,
} from '../src/store/serverAccounts';

const mockSecureStore = SecureStore as unknown as {
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

describe('serverAccounts registry', () => {
  const memory = new Map<string, string>();

  beforeEach(() => {
    memory.clear();
    jest.clearAllMocks();
    mockSecureStore.getItemAsync.mockImplementation(async (key: string) => memory.get(key) ?? null);
    mockSecureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      memory.set(key, value);
    });
    mockSecureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      memory.delete(key);
    });
  });

  it('migrates legacy single-server keys to registry', async () => {
    memory.set('jot_server_url', 'HTTPS://Example.com:443/path');
    memory.set('jot_session', 'legacy-token');
    memory.set('jot_cached_profile', '{"user":{"id":"1"},"settings":{"theme":"system"}}');

    await ensureServerRegistryMigrated();

    const active = await getActiveServer();
    expect(active?.serverUrl).toBe('https://example.com');
    expect(active?.serverId).toBeTruthy();
    expect(memory.get('jot_server_url')).toBeUndefined();
    expect(memory.get('jot_session')).toBeUndefined();
    expect(memory.get('jot_cached_profile')).toBeUndefined();
    expect(memory.get(getServerScopedStorageKey(active!.serverId, 'session'))).toBe('legacy-token');
    expect(memory.get(getServerScopedStorageKey(active!.serverId, 'cached_profile'))).toBe(
      '{"user":{"id":"1"},"settings":{"theme":"system"}}',
    );
  });

  it('cleans up legacy keys when legacy URL is invalid', async () => {
    memory.set('jot_server_url', 'not-a-valid-url');
    memory.set('jot_session', 'legacy-token');
    memory.set('jot_cached_profile', '{"legacy":true}');

    await ensureServerRegistryMigrated();

    expect(memory.get('jot_server_url')).toBeUndefined();
    expect(memory.get('jot_session')).toBeUndefined();
    expect(memory.get('jot_cached_profile')).toBeUndefined();
    expect(memory.get('jot_server_registry_migrated_v1')).toBe('1');
  });

  it('cleans up legacy keys when registry exists without migration marker', async () => {
    const serverId = 'srv_manual01';
    memory.set(
      'jot_server_registry_v1',
      JSON.stringify({
        activeServerId: serverId,
        servers: [{ serverId, serverUrl: 'https://existing.example.com', lastUsedAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    memory.set('jot_server_url', 'https://legacy.example.com');
    memory.set('jot_session', 'legacy-token');
    memory.set('jot_cached_profile', '{"legacy":true}');

    await ensureServerRegistryMigrated();

    expect(memory.get('jot_server_url')).toBeUndefined();
    expect(memory.get('jot_session')).toBeUndefined();
    expect(memory.get('jot_cached_profile')).toBeUndefined();
    expect(memory.get('jot_server_registry_migrated_v1')).toBe('1');
  });

  it('deduplicates by canonical origin', async () => {
    await ensureServerRegistryMigrated();
    const first = await addServer('https://example.com/path');
    expect(first.success).toBe(true);

    const second = await addServer('HTTPS://EXAMPLE.com:443/other');
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.code).toBe('DUPLICATE');
      expect(second.existingServerId).toBe((first as { success: true; serverId: string }).serverId);
    }
  });

  it('switches active server and returns server-scoped session', async () => {
    await ensureServerRegistryMigrated();
    const serverA = await addServer('https://a.example.com');
    const serverB = await addServer('https://b.example.com');
    expect(serverA.success).toBe(true);
    expect(serverB.success).toBe(true);
    if (!serverA.success || !serverB.success) {
      throw new Error('expected successful server adds');
    }

    memory.set(getServerScopedStorageKey(serverA.serverId, 'session'), 'token-a');
    memory.set(getServerScopedStorageKey(serverB.serverId, 'session'), 'token-b');

    const switched = await switchServer(serverB.serverId);
    expect(switched).toBe(true);
    const active = await getActiveServer();
    expect(active?.serverId).toBe(serverB.serverId);
    const token = await getServerStorageValue(serverB.serverId, 'session');
    expect(token).toBe('token-b');
  });

  it('lists servers by last used descending', async () => {
    await ensureServerRegistryMigrated();
    const a = await addServer('https://a.example.com');
    const b = await addServer('https://b.example.com');
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    if (!a.success || !b.success) {
      throw new Error('expected successful server adds');
    }

    await switchServer(a.serverId);
    const list = await listServers();
    expect(list[0].serverId).toBe(a.serverId);
  });
});
