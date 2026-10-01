/**
 * What the deployed e2e Worker (`worker.ts`) and its suite
 * (`e2e/deployed.test.ts`) share. Types only, so the Node-side suite can
 * import it without the Workers runtime.
 */
import type { PiMessage, PiOperationResult } from "../harness/types";

/** Header every e2e route requires, carrying the deploy-time `E2E_TOKEN`. */
export const TOKEN_HEADER = "x-e2e-token";

/**
 * An agent's outcome: what `GET /e2e/:agent/result` returns once the agent
 * reports it (`null` before), and what `GET /e2e/:agent/status` reads from
 * the agent itself.
 */
export type ChaosStatus = {
  /** How many instances of the object have run, counting the first. */
  readonly instances: number;
  /** The operation's outcome, or `pending` while pi is still working on it. */
  readonly operation: PiOperationResult | { readonly status: "pending" };
  /** The root session's transcript. */
  readonly messages: readonly PiMessage[];
};

/** One step an agent reported while working, in the order it happened. */
export type ChaosProgress = {
  /** `generating` when the model starts streaming a message, or `tool:<name>`. */
  readonly label: string;
  /** A random id per object instance, so a restart shows up as a new id. */
  readonly instance: string;
  /** Epoch milliseconds. */
  readonly at: number;
};
