/**
 * resource — the contract for anything with a lifecycle OUTSIDE the
 * log: browser sessions, MCP connections and their OAuth tokens,
 * sandboxes, child agents, workflow instances.
 *
 * The log records references to these; it cannot resurrect them
 * (residue 3). Each provider owns reattachment behind ensure(), so the
 * residue lives inside the provider and stays invisible to loop, context
 * and channel authors.
 *
 * Allowed imports: kernel.
 */

export type ResourceHealth = "ready" | "degraded" | "gone";

export interface ExternalResource {
  /** Stable identity, safe to persist inside payloads. */
  readonly id: string;
  /**
   * Bring the resource to a usable state — connect, reauth, relaunch, or
   * recreate. Idempotent; called on demand, never eagerly at boot. Failure
   * here is the resource's honest "gone".
   */
  ensure(): Promise<void>;
  health(): Promise<ResourceHealth>;
  dispose(): Promise<void>;
}
