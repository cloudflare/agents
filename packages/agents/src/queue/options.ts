import type { RetryOptions } from "../retries";
import type { QueueCallbacks, QueueHandlers } from "./types";

/** Events emitted while a Queue creates, retries, or fails work. */
export type QueueEventType = "queue:create" | "queue:retry" | "queue:error";

/**
 * Optional callbacks and policy for a Queue capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface QueueOptions<Handlers extends QueueHandlers = QueueCallbacks> {
  /**
   * Named callbacks this Queue can run. Each item persists a callback name;
   * registration in a field initializer re-binds the names on every Durable
   * Object wake, so register unconditionally. Names outside this map are
   * rejected unless a composition-root resolver supplies them — the internal
   * aperture behind `Agent`'s name-based queue API.
   */
  readonly callbacks?: Handlers;

  /** Default callback retry policy. */
  readonly retry?: RetryOptions;

  /** Observe terminal callback errors. Runs as capability code without host context. */
  readonly onError?: (error: unknown) => void | Promise<void>;
}
