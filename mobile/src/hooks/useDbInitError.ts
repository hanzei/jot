import { useCallback, useState } from 'react';

/**
 * Tracks SQLiteProvider init failures per provider instance.
 *
 * One shared error slot is not enough. A provider unmounted by a server switch
 * or a retry can still reject afterwards, and its `onError` is the callback from
 * the render that mounted it — so the late rejection arrives tagged with the old
 * instance. With a single slot that write lands last and wins, clearing the live
 * instance's error and silently dismissing the error screen while the database
 * is still unusable.
 *
 * Keying by instance means a stale rejection lands under its own key and leaves
 * the current one intact. The map is only as large as the number of provider
 * instances in a session (server switches plus retries), so it is not worth
 * pruning.
 */
export function useDbInitError(instance: string): {
  hasError: boolean;
  reportError: (error: Error) => void;
} {
  const [errors, setErrors] = useState<Record<string, Error>>({});

  const reportError = useCallback(
    (error: Error) => {
      setErrors((prev) => (prev[instance] !== undefined ? prev : { ...prev, [instance]: error }));
    },
    [instance],
  );

  return { hasError: errors[instance] !== undefined, reportError };
}
