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
