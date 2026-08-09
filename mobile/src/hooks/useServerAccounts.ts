import { useCallback, useState } from 'react';
import { getActiveServer, listServers, type ServerAccountEntry } from '../store/serverAccounts';

export interface ServerAccountsSnapshot {
  servers: ServerAccountEntry[];
  activeServerId: string | null;
}

export interface UseServerAccountsResult extends ServerAccountsSnapshot {
  /**
   * Re-reads the registry into state and also returns what it read, so callers
   * that must branch on the fresh list (e.g. "was that the last server?") don't
   * have to wait for the state update to land.
   */
  reload: () => Promise<ServerAccountsSnapshot>;
}

const EMPTY_SNAPSHOT: ServerAccountsSnapshot = { servers: [], activeServerId: null };

/**
 * Registry-backed list of configured servers, shared by the drawer and the
 * login screen so both render the same thing. Deliberately not auto-loading:
 * callers pull it when their surface becomes visible.
 */
export function useServerAccounts(): UseServerAccountsResult {
  const [snapshot, setSnapshot] = useState<ServerAccountsSnapshot>(EMPTY_SNAPSHOT);

  const reload = useCallback(async (): Promise<ServerAccountsSnapshot> => {
    const [servers, activeServer] = await Promise.all([listServers(), getActiveServer()]);
    const next: ServerAccountsSnapshot = {
      servers,
      activeServerId: activeServer?.serverId ?? null,
    };
    setSnapshot(next);
    return next;
  }, []);

  return { servers: snapshot.servers, activeServerId: snapshot.activeServerId, reload };
}
