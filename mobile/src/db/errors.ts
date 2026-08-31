/**
 * True when `err` is expo-sqlite's "the database handle was closed underneath an
 * in-flight operation" rejection — the `Access to closed resource` error thrown
 * by NativeDatabase/NativeStatement calls (`prepareAsync`, `execAsync`,
 * `finalizeAsync`, …) once the handle they run against has been closed.
 *
 * The handle is owned by the `SQLiteProvider` in App.tsx, which is keyed on the
 * active database name and a DB-init-attempt counter. A server switch, a DB-init
 * retry, or sign-out remounts that provider, and the outgoing instance calls
 * `closeAsync()` on the old handle. A background operation that captured the old
 * `db` before the remount — a queue drain, a users/notes/labels sync — then
 * rejects on its next call when it resumes after an `await`.
 *
 * Such a rejection is terminal for that handle: it never reopens, and a fresh
 * `SQLiteProvider` instance is already (or about to be) mounted to drive sync.
 * Callers therefore treat it as a quiet stop rather than a retryable failure —
 * retrying only spins against the dead handle, escalates the drain's backoff to
 * its failure cap, and floods diagnostics with `Access to closed resource` noise
 * that masks real problems.
 */
export function isClosedDatabaseError(err: unknown): boolean {
  // expo's CodedError folds the underlying reason into its own message (e.g.
  // "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n
  // → Caused by: Access to closed resource"), so the marker can sit in either the
  // top-level message or a nested cause. Walk the cause chain to catch both.
  for (let current: unknown = err, depth = 0; current != null && depth < 5; depth++) {
    const message =
      current instanceof Error ? current.message : typeof current === 'string' ? current : '';
    if (message.includes('Access to closed resource')) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
