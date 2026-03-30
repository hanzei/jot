import * as SecureStore from 'expo-secure-store';
import { canonicalizeServerOrigin, createServerId } from '@jot/shared';

export type ServerAddErrorCode =
  | 'INVALID_URL'
  | 'DUPLICATE'
  | 'NETWORK_ERROR'
  | 'INVALID_ENDPOINT'
  | 'AUTH_REQUIRED'
  | 'SERVER_ADD_ERROR';

export type AddServerResult =
  | { success: true; serverId: string }
  | { success: false; code: ServerAddErrorCode; message: string; retryable: boolean; details?: unknown; existingServerId?: string };

export interface ServerAccountEntry {
  serverId: string;
  serverUrl: string;
  displayName?: string;
  lastUsedAt: string;
}

interface ServerRegistryState {
  activeServerId: string | null;
  servers: ServerAccountEntry[];
}

const REGISTRY_KEY = 'jot_server_registry_v1';
const LEGACY_SERVER_URL_KEY = 'jot_server_url';
const LEGACY_SESSION_KEY = 'jot_session';
const LEGACY_CACHED_PROFILE_KEY = 'jot_cached_profile';
const LEGACY_MIGRATION_KEY = 'jot_server_registry_migrated_v1';

export const SERVER_STORAGE_PREFIX = 'jot_server_v1';

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyState(): ServerRegistryState {
  return {
    activeServerId: null,
    servers: [],
  };
}

function sortByRecentUse(servers: ServerAccountEntry[]): ServerAccountEntry[] {
  return [...servers].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
}

function normalizeRegistry(raw: unknown): ServerRegistryState {
  if (!raw || typeof raw !== 'object') {
    return createEmptyState();
  }
  const obj = raw as { activeServerId?: unknown; servers?: unknown };
  const servers = Array.isArray(obj.servers)
    ? obj.servers
        .map((entry): ServerAccountEntry | null => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const candidate = entry as {
            serverId?: unknown;
            serverUrl?: unknown;
            displayName?: unknown;
            lastUsedAt?: unknown;
          };
          if (typeof candidate.serverId !== 'string' || typeof candidate.serverUrl !== 'string') {
            return null;
          }
          const canonical = canonicalizeServerOrigin(candidate.serverUrl);
          if (!canonical) {
            return null;
          }
          return {
            serverId: candidate.serverId,
            serverUrl: canonical,
            displayName: typeof candidate.displayName === 'string' ? candidate.displayName : undefined,
            lastUsedAt: typeof candidate.lastUsedAt === 'string' ? candidate.lastUsedAt : nowIso(),
          };
        })
        .filter((entry): entry is ServerAccountEntry => entry !== null)
    : [];

  const dedupedByServerId = new Map<string, ServerAccountEntry>();
  for (const entry of servers) {
    dedupedByServerId.set(entry.serverId, entry);
  }
  const deduped = Array.from(dedupedByServerId.values());

  let activeServerId = typeof obj.activeServerId === 'string' ? obj.activeServerId : null;
  if (activeServerId && !deduped.some((entry) => entry.serverId === activeServerId)) {
    activeServerId = deduped.length > 0 ? sortByRecentUse(deduped)[0].serverId : null;
  }

  return {
    activeServerId,
    servers: deduped,
  };
}

async function loadRegistryState(): Promise<ServerRegistryState> {
  const raw = await SecureStore.getItemAsync(REGISTRY_KEY);
  if (!raw) {
    return createEmptyState();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRegistry(parsed);
  } catch {
    return createEmptyState();
  }
}

async function saveRegistryState(state: ServerRegistryState): Promise<void> {
  await SecureStore.setItemAsync(
    REGISTRY_KEY,
    JSON.stringify({
      activeServerId: state.activeServerId,
      servers: state.servers,
    }),
  );
}

async function deleteLegacyKeys(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(LEGACY_SERVER_URL_KEY),
    SecureStore.deleteItemAsync(LEGACY_SESSION_KEY),
    SecureStore.deleteItemAsync(LEGACY_CACHED_PROFILE_KEY),
  ]);
}

function buildServerStorageKey(serverId: string, key: 'session' | 'cached_profile' | 'server_url'): string {
  return `${SERVER_STORAGE_PREFIX}_${serverId}_${key}`;
}

export function getServerScopedStorageKey(serverId: string, key: 'session' | 'cached_profile' | 'server_url'): string {
  return buildServerStorageKey(serverId, key);
}

export async function listServers(): Promise<ServerAccountEntry[]> {
  const state = await loadRegistryState();
  return sortByRecentUse(state.servers);
}

export async function getActiveServer(): Promise<ServerAccountEntry | null> {
  const state = await loadRegistryState();
  if (!state.activeServerId) {
    return null;
  }
  return state.servers.find((entry) => entry.serverId === state.activeServerId) ?? null;
}

async function touchServerAsActive(serverId: string): Promise<void> {
  const state = await loadRegistryState();
  const nextServers = state.servers.map((entry) =>
    entry.serverId === serverId
      ? {
          ...entry,
          lastUsedAt: nowIso(),
        }
      : entry,
  );
  await saveRegistryState({
    activeServerId: serverId,
    servers: nextServers,
  });
}

export async function switchServer(serverId: string): Promise<boolean> {
  const state = await loadRegistryState();
  const exists = state.servers.some((entry) => entry.serverId === serverId);
  if (!exists) {
    return false;
  }
  await touchServerAsActive(serverId);
  return true;
}

export async function renameServer(serverId: string, label: string): Promise<boolean> {
  const state = await loadRegistryState();
  let found = false;
  const nextServers = state.servers.map((entry) => {
    if (entry.serverId !== serverId) {
      return entry;
    }
    found = true;
    const trimmed = label.trim();
    return {
      ...entry,
      displayName: trimmed.length > 0 ? trimmed : undefined,
    };
  });

  if (!found) {
    return false;
  }

  await saveRegistryState({
    activeServerId: state.activeServerId,
    servers: nextServers,
  });
  return true;
}

export async function addServer(url: string): Promise<AddServerResult> {
  const canonical = canonicalizeServerOrigin(url);
  if (!canonical) {
    return {
      success: false,
      code: 'INVALID_URL',
      message: 'Invalid server URL.',
      retryable: false,
    };
  }

  const serverId = createServerId(canonical);
  const state = await loadRegistryState();
  const existing = state.servers.find((entry) => entry.serverId === serverId || entry.serverUrl === canonical);
  if (existing) {
    return {
      success: false,
      code: 'DUPLICATE',
      message: 'Server is already added.',
      retryable: false,
      existingServerId: existing.serverId,
    };
  }

  const now = nowIso();
  const nextEntry: ServerAccountEntry = {
    serverId,
    serverUrl: canonical,
    lastUsedAt: now,
  };
  await saveRegistryState({
    activeServerId: state.activeServerId ?? serverId,
    servers: [...state.servers, nextEntry],
  });
  await SecureStore.setItemAsync(buildServerStorageKey(serverId, 'server_url'), canonical);

  return {
    success: true,
    serverId,
  };
}

export async function removeServer(serverId: string): Promise<boolean> {
  const state = await loadRegistryState();
  const existing = state.servers.find((entry) => entry.serverId === serverId);
  if (!existing) {
    return false;
  }
  const nextServers = state.servers.filter((entry) => entry.serverId !== serverId);
  let nextActiveServerId = state.activeServerId;
  if (state.activeServerId === serverId) {
    nextActiveServerId = nextServers.length > 0 ? sortByRecentUse(nextServers)[0].serverId : null;
  }
  await saveRegistryState({
    activeServerId: nextActiveServerId,
    servers: nextServers,
  });

  await Promise.all([
    SecureStore.deleteItemAsync(buildServerStorageKey(serverId, 'session')),
    SecureStore.deleteItemAsync(buildServerStorageKey(serverId, 'cached_profile')),
    SecureStore.deleteItemAsync(buildServerStorageKey(serverId, 'server_url')),
  ]);

  return true;
}

export async function ensureServerRegistryMigrated(): Promise<void> {
  const migrationDone = await SecureStore.getItemAsync(LEGACY_MIGRATION_KEY);
  if (migrationDone === '1') {
    return;
  }

  const state = await loadRegistryState();
  if (state.servers.length > 0) {
    if (!state.activeServerId) {
      await saveRegistryState({
        activeServerId: sortByRecentUse(state.servers)[0].serverId,
        servers: state.servers,
      });
    }
    // If registry already exists but migration marker is missing (for example
    // from an interrupted run), still clean up legacy keys.
    await deleteLegacyKeys();
    await SecureStore.setItemAsync(LEGACY_MIGRATION_KEY, '1');
    return;
  }

  const legacyServerUrl = await SecureStore.getItemAsync(LEGACY_SERVER_URL_KEY);
  const canonical = legacyServerUrl ? canonicalizeServerOrigin(legacyServerUrl) : null;
  if (!canonical) {
    await deleteLegacyKeys();
    await SecureStore.setItemAsync(LEGACY_MIGRATION_KEY, '1');
    return;
  }

  const serverId = createServerId(canonical);
  const entry: ServerAccountEntry = {
    serverId,
    serverUrl: canonical,
    lastUsedAt: nowIso(),
  };
  await saveRegistryState({
    activeServerId: serverId,
    servers: [entry],
  });
  await SecureStore.setItemAsync(buildServerStorageKey(serverId, 'server_url'), canonical);

  const [legacySession, legacyCachedProfile] = await Promise.all([
    SecureStore.getItemAsync(LEGACY_SESSION_KEY),
    SecureStore.getItemAsync(LEGACY_CACHED_PROFILE_KEY),
  ]);
  if (legacySession) {
    await SecureStore.setItemAsync(buildServerStorageKey(serverId, 'session'), legacySession);
  }
  if (legacyCachedProfile) {
    await SecureStore.setItemAsync(buildServerStorageKey(serverId, 'cached_profile'), legacyCachedProfile);
  }

  await deleteLegacyKeys();
  await SecureStore.setItemAsync(LEGACY_MIGRATION_KEY, '1');
}

export async function getServerStorageValue(serverId: string, key: 'session' | 'cached_profile' | 'server_url'): Promise<string | null> {
  return SecureStore.getItemAsync(buildServerStorageKey(serverId, key));
}

export async function setServerStorageValue(serverId: string, key: 'session' | 'cached_profile' | 'server_url', value: string): Promise<void> {
  await SecureStore.setItemAsync(buildServerStorageKey(serverId, key), value);
}

export async function deleteServerStorageValue(serverId: string, key: 'session' | 'cached_profile' | 'server_url'): Promise<void> {
  await SecureStore.deleteItemAsync(buildServerStorageKey(serverId, key));
}
