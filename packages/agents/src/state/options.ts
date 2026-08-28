import type { Connection } from "../lifecycle/durable-object-lifecycle";

/**
 * Source of a state change.
 *
 * `"server"` marks a change originated by host code (e.g. `setState()`); a
 * {@link Connection} marks a change that arrived from that client. The source
 * determines which connection is excluded from the change broadcast and is
 * forwarded to the host's notification hook.
 */
export type StateChangeSource<Conn extends Connection = Connection> =
  | Conn
  | "server";

/**
 * Optional callbacks and policy for a {@link StateManager} capability.
 *
 * State validation and the post-change notification hook stay on the host's
 * public surface (an Agent subclass overrides `validateStateChange` and
 * `onStateChanged`). The host injects them here so the capability owns storage
 * and change ordering while the host keeps the developer-facing hooks.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface StateManagerOptions<State = unknown> {
  /**
   * Initial state seeded on first access when no state was previously stored.
   * `undefined` seeds nothing.
   */
  readonly initialState?: State;

  /** Called after a change is validated and persisted. */
  readonly onChanged?: (state: State, source: StateChangeSource) => void;

  /**
   * Synchronous gating hook run before a change is persisted. Throw to reject
   * the change; the throw propagates to the caller of {@link StateManager.set}.
   */
  readonly validateStateChange?: (
    nextState: State,
    source: StateChangeSource
  ) => void;
}
