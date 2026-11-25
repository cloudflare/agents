/**
 * Whether an agent's broadcast now reaches sockets its `getConnections()`
 * does not list: a sub-agent during its start, before it read its sockets
 * from the root. Its own module with no runtime imports, so the chat entry
 * can read it without loading the dynamic-agents runtime.
 *
 * @internal Sibling-package support, not a public API.
 */

/** Each agent's answer, registered by its dynamic-agents capability. */
const reachesUnlisted = new WeakMap<object, () => boolean>();

/** Register how `agent` answers {@link broadcastReachesUnlistedSockets}. */
export function registerUnlistedSockets(
  agent: object,
  answer: () => boolean
): void {
  reachesUnlisted.set(agent, answer);
}

/** Whether a broadcast by `agent` now reaches sockets it does not list. */
export function broadcastReachesUnlistedSockets(agent: object): boolean {
  return reachesUnlisted.get(agent)?.() ?? false;
}

/**
 * Who learns when the root sent the broadcast being made now: set by the
 * caller around one synchronous `broadcast()` call, taken by the sub-agent's
 * broadcast before its first await.
 */
let deliveryReport: ((sentAt: number) => void) | undefined;

/**
 * Run `broadcast` (one synchronous `broadcast()` call) so a sub-agent's
 * broadcast reports to `onSent` when the root sent it (ms, root clock).
 */
export function reportDelivery(
  onSent: (sentAt: number) => void,
  broadcast: () => void
): void {
  deliveryReport = onSent;
  try {
    broadcast();
  } finally {
    deliveryReport = undefined;
  }
}

/** The report for the broadcast being made now, once. */
export function takeDeliveryReport(): ((sentAt: number) => void) | undefined {
  const report = deliveryReport;
  deliveryReport = undefined;
  return report;
}
