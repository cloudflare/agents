/**
 * Query value constructors (ADR 0003). These implement the `declare function`
 * signatures in the contract: every constructor produces a bounded Query;
 * assertBounded is the runtime invariant LogView.query enforces.
 */

import type { Query, Seq } from "../contract";

/** All entries after an exclusive sequence floor. */
export function since(seq: Seq): Query {
  return { after: seq };
}

/** Entries strictly between two sequence bounds. */
export function between(after: Seq, before: Seq): Query {
  return { after, before };
}

/** The newest entries of one kind (one by default). */
export function latest(kind: string, n = 1): Query {
  return { kinds: [kind], limit: n };
}

/** Validate and pass through a bounded query. */
export function window(query: Query): Query {
  assertBounded(query);
  return query;
}

export function assertBounded(q: Query): void {
  if (q.after === undefined && q.before === undefined && q.limit === undefined) {
    throw new Error(
      "unbounded query: at least one of {after, before, limit} is required " +
        "(use LogExport.scan for deliberate full traversal)"
    );
  }
}
