import type { InboxPolicy, InboxRequest } from "./types";

/** A policy as the record stores it. */
export type NormalizedPolicy = {
  readonly name: InboxRequest["policy"];
  /** For `debounce`, the quiet period; otherwise `null`. */
  readonly debounceMs: number | null;
};

/**
 * Check a submit's policy and reduce it to what the record stores.
 *
 * @throws For a name that is not a policy, or a debounce that is not a
 *   finite number of milliseconds at least 0.
 */
export function normalizePolicy(
  policy: InboxPolicy | undefined
): NormalizedPolicy {
  if (policy === undefined) return { name: "queue", debounceMs: null };
  if (typeof policy === "string") {
    if (!["queue", "latest", "merge", "drop"].includes(policy)) {
      throw new Error(`Unknown inbox policy ${JSON.stringify(policy)}`);
    }
    return { name: policy, debounceMs: null };
  }
  const { debounceMs } = policy;
  if (
    typeof debounceMs !== "number" ||
    !Number.isFinite(debounceMs) ||
    debounceMs < 0
  ) {
    throw new Error("Inbox debounceMs must be a finite number >= 0");
  }
  return { name: "debounce", debounceMs };
}

/**
 * What a request arriving at a lane does: whether it overlaps (and may be
 * superseded at the front of the lane), or is dropped at once.
 *
 * @param busy - The lane has an open request.
 */
export function arrival(
  policy: NormalizedPolicy,
  busy: boolean
): { overlap: boolean; dropped: boolean } {
  return {
    overlap: busy && policy.name !== "queue" && policy.name !== "drop",
    dropped: busy && policy.name === "drop"
  };
}
