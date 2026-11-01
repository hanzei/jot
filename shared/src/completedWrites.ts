// The one gate every client passes a server item snapshot's `completed` flags
// through before applying them to its local state.
//
// The completed-flag endpoints (toggle-completed, set-completed, delete) answer
// with the note's *full* item list as the server saw it right after that one
// write. When rows are checked off faster than requests come back, the response
// to an earlier tap still reports every later-tapped row unchecked, and
// responses can land out of order. Applying such a snapshot wholesale put rows
// back in the active list — or, when the stale response landed last, left them
// unchecked locally while the server had them checked.
//
// Two rules decide which flags a snapshot may set:
//
// 1. In-flight writes. Each optimistic completed write claims the items it
//    changed until it settles. A snapshot skips any item a *later* write still
//    claims: that write's optimistic value is newer than anything the snapshot
//    can know about, and its own response will settle the item. Snapshots that
//    belong to no write (a queue drain's replay, a bulk delete) skip every
//    claimed item.
// 2. Server order. A snapshot item older (by server `updated_at`) than one
//    already seen is stale, and yields the newest value seen instead. This is
//    what keeps an out-of-order response from undoing a later write, and why a
//    response may still set items it never claimed — e.g. a child the server
//    cascaded to that the client did not know was nested. Order is only tracked
//    for items a local write has claimed, the only ones a stale snapshot can
//    undo; an item without a readable timestamp cannot be ordered and is taken
//    as it stands.
//
// A failed write hands the value it replaced to the next write still claiming
// the item, so overlapping writes that both fail unwind to where the item was
// before either of them.

/** A server item as far as the completed gate needs it. */
export interface ServerCompletedItem {
  id: string;
  completed: boolean;
  updated_at?: string | undefined;
}

export interface CompletedWriteTracker {
  /**
   * Records an optimistic write: `priorById` holds, for every item it changed,
   * the value it replaced. Returns the write's token.
   */
  begin(priorById: ReadonlyMap<string, boolean>): number;
  /**
   * Filters a server snapshot down to the completed values that may be applied
   * locally. `write` is the token of the write the snapshot answers, or null for
   * one that answers none. Does not settle the write.
   */
  accept(write: number | null, serverItems: readonly ServerCompletedItem[]): Map<string, boolean>;
  /** Whether no later write has claimed `id` since `write` did. */
  decides(write: number, id: string): boolean;
  /**
   * Settles a failed write. Returns the values to revert to: the prior value of
   * every item it changed that no later write has claimed since.
   */
  fail(write: number): Map<string, boolean>;
  /** Settles a write. Idempotent, so it is safe in a `finally` after fail(). */
  end(write: number): void;
  /**
   * The items some in-flight write still claims. An editor's save diff leaves
   * their completed flags out (diffItems' `heldCompleted`): the write's own
   * endpoint applies the cascade atomically, whereas a PATCH unchecking a
   * parent would make the server uncheck all its children.
   */
  claimed(): ReadonlySet<string>;
}

interface Claim {
  write: number;
  prior: boolean;
}

interface ParsedTimestamp {
  wholeSecondMs: number;
  nanos: number;
}

interface Seen {
  at: ParsedTimestamp;
  completed: boolean;
}

const TIMESTAMP_PATTERN = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/;

/**
 * Orders two server timestamps (RFC 3339 with up to nanosecond fractions, as Go
 * encodes them — the fraction's length varies, so the strings do not sort).
 * Returns a negative number when a is earlier, positive when later, 0 when
 * equal, or null when either cannot be read.
 */
export const compareServerTimestamps = (a: string, b: string): number | null => {
  const pa = parseServerTimestamp(a);
  const pb = parseServerTimestamp(b);
  return pa && pb ? compareParsed(pa, pb) : null;
};

const compareParsed = (a: ParsedTimestamp, b: ParsedTimestamp): number =>
  a.wholeSecondMs !== b.wholeSecondMs ? a.wholeSecondMs - b.wholeSecondMs : a.nanos - b.nanos;

const parseServerTimestamp = (value: string): ParsedTimestamp | null => {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;
  const wholeSecondMs = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(wholeSecondMs)) return null;
  return { wholeSecondMs, nanos: Number((match[2] ?? '').padEnd(9, '0')) };
};

export const createCompletedWriteTracker = (): CompletedWriteTracker => {
  // Per item, the writes still claiming it, oldest first.
  const claimsById = new Map<string, Claim[]>();
  // Keyed by every item a local write has ever claimed: the newest server state
  // seen in any snapshot, or null until one with a readable timestamp arrives.
  // Bounded by what this client writes, not by every item synced.
  const seenById = new Map<string, Seen | null>();
  let nextWrite = 0;

  const claimedLater = (id: string, write: number | null): boolean => {
    const claims = claimsById.get(id);
    if (!claims) return false;
    return write === null || claims.some(claim => claim.write > write);
  };

  // Records a snapshot item's server state if it is the newest seen, and returns
  // the newest completed value known for it.
  const newestCompleted = (item: ServerCompletedItem): boolean => {
    if (!seenById.has(item.id) || item.updated_at === undefined) return item.completed;
    const at = parseServerTimestamp(item.updated_at);
    if (!at) return item.completed;
    const seen = seenById.get(item.id);
    if (seen && compareParsed(at, seen.at) < 0) return seen.completed;
    seenById.set(item.id, { at, completed: item.completed });
    return item.completed;
  };

  const release = (write: number, handOff: boolean): Map<string, boolean> => {
    const revert = new Map<string, boolean>();
    for (const entry of claimsById) {
      const id = entry[0];
      const claims = entry[1];
      const index = claims.findIndex(claim => claim.write === write);
      if (index === -1) continue;
      const own = claims[index]!; // findIndex just located it
      const next = claims[index + 1];
      if (handOff) {
        // The value this write replaced is what the item falls back to if the
        // next write fails too; with no next write, it is the revert value.
        if (next) next.prior = own.prior;
        else revert.set(id, own.prior);
      }
      claims.splice(index, 1);
      if (claims.length === 0) claimsById.delete(id);
    }
    return revert;
  };

  return {
    begin(priorById) {
      nextWrite += 1;
      for (const entry of priorById) {
        const claims = claimsById.get(entry[0]);
        const claim = { write: nextWrite, prior: entry[1] };
        if (!seenById.has(entry[0])) seenById.set(entry[0], null);
        if (claims) claims.push(claim);
        else claimsById.set(entry[0], [claim]);
      }
      return nextWrite;
    },
    accept(write, serverItems) {
      const accepted = new Map<string, boolean>();
      for (const item of serverItems) {
        // Evaluated even for a skipped item, so what it said still orders later
        // snapshots.
        const completed = newestCompleted(item);
        if (!claimedLater(item.id, write)) accepted.set(item.id, completed);
      }
      return accepted;
    },
    decides(write, id) {
      return !claimedLater(id, write);
    },
    fail(write) {
      return release(write, true);
    },
    end(write) {
      release(write, false);
    },
    claimed() {
      return new Set(claimsById.keys());
    },
  };
};
