import { useOfflineContext } from '../store/OfflineContext';

export function useNetworkStatus(): { isConnected: boolean } {
  const { isConnected } = useOfflineContext();
  return { isConnected };
}
