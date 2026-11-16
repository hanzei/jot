import type { NetInfoState } from '@react-native-community/netinfo';

/**
 * What identifies the network the device is on, for spotting a switch to
 * another network while it stays connected (#1266).
 *
 * The app treats NetInfo's `isConnected` alone as "device online", so leaving
 * one network for another, or a captive portal letting the device through,
 * no longer shows up as an offline→online transition. Those are still the
 * moments a server that was unreachable may have become reachable, so they
 * must start a reconnect. `isInternetReachable` stays in here for that reason:
 * it is not used to decide online/offline, only as a sign the network changed.
 *
 * Signal strength and other details NetInfo reports are left out on purpose:
 * they change constantly, and each reconnect revalidates the session and
 * drains the queue.
 */
export interface NetworkIdentity {
  type: string;
  /** The device's IP address on this network, or null when NetInfo does not report one. */
  ipAddress: string | null;
  /** null while NetInfo has not decided yet. */
  internetReachable: boolean | null;
}

export function networkIdentity(state: NetInfoState): NetworkIdentity {
  const details = state.details as { ipAddress?: unknown } | null;
  const ipAddress = typeof details?.ipAddress === 'string' && details.ipAddress !== '' ? details.ipAddress : null;
  return {
    type: state.type,
    ipAddress,
    internetReachable: typeof state.isInternetReachable === 'boolean' ? state.isInternetReachable : null,
  };
}

/**
 * Whether `next` is a different network (or the same one with internet access
 * gained or lost) compared with `prev`. A value going from unknown (null) to
 * known is NetInfo finishing its check, not a change, so it does not count.
 */
export function isNetworkChange(prev: NetworkIdentity | null, next: NetworkIdentity): boolean {
  if (prev === null) return false;
  if (prev.type !== next.type) return true;
  if (prev.ipAddress !== null && next.ipAddress !== null && prev.ipAddress !== next.ipAddress) return true;
  return prev.internetReachable !== null
    && next.internetReachable !== null
    && prev.internetReachable !== next.internetReachable;
}

/** `next`, keeping `prev`'s known values where `next` does not know them yet. */
export function mergeNetworkIdentity(prev: NetworkIdentity | null, next: NetworkIdentity): NetworkIdentity {
  if (prev === null || prev.type !== next.type) return next;
  return {
    type: next.type,
    ipAddress: next.ipAddress ?? prev.ipAddress,
    internetReachable: next.internetReachable ?? prev.internetReachable,
  };
}
