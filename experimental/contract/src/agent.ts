/**
 * agent — the composition root. An agent definition is a VALUE assembling the
 * substrate contracts and one Harness; there is no base class to extend. A
 * preset is an exported AgentDefinition users copy and edit.
 *
 * The runtime beneath (DO hosting, alarm/clock, boot, connections, RPC — the
 * substrate this contract deliberately excludes) receives this value and
 * drives it: channels started, consumers pumped, admission consulted, harness
 * driven, and reconcilers registered.
 *
 * Allowed imports: everything in this package.
 */

import type { ReconcilerName } from "./kernel.js";
import type { Reconciler } from "./transcript.js";
import type { Channel } from "./channel.js";
import type { AdmissionPolicy } from "./admission.js";
import type { ToolMiddleware, ToolProvider } from "./tools.js";
import type { Harness } from "./loop.js";

export interface AgentDefinition {
  /** Substrate world-boundary: external surfaces into and out of the log. */
  readonly channels: readonly Channel[];
  readonly admission: AdmissionPolicy;
  /** Substrate world-boundary: governed effects the harness may invoke. */
  readonly tools: {
    readonly providers: readonly ToolProvider[];
    /** Applied outermost-first; gate/HITL belongs here, not in providers. */
    readonly middleware?: readonly ToolMiddleware[];
  };
  /**
   * Module-owned recovery handlers beyond what ToolRuntime registers itself.
   * Names are durable; renaming one orphans its open claims.
   */
  readonly reconcilers?: Readonly<Record<ReconcilerName, Reconciler>>;
  /** How this agent thinks; default definitions use stepHarness({...}). */
  readonly harness: Harness;
}
