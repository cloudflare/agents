import type { JsonSchemaToolDescriptors } from "../json-schema-types";

// ---------------------------------------------------------------------------
// Annotations — per-method permissions/classification.
// ---------------------------------------------------------------------------

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type ToolAnnotations = {
  /** Requires user approval before executing. Unannotated methods execute immediately. */
  requiresApproval?: boolean;
  /**
   * Replay policy for the durable log. `"reexecute"` marks the call ephemeral:
   * its result is never stored, and a replay re-executes the call instead of
   * replaying a recorded result. Only valid for idempotent reads — the call
   * runs again on every resume pass. Keeps large read results (file contents,
   * directory listings) out of the durable log. Defaults to `"log"`.
   */
  replay?: "log" | "reexecute";
};

// ---------------------------------------------------------------------------
// Execution lifecycle — context for per-execution resources.
// ---------------------------------------------------------------------------

/**
 * Passed to a tool's `execute`/`revert` so a connector knows which codemode
 * execution the call belongs to. The id is stable across a run's pause/resume
 * passes, so it's the right key for a per-execution resource (e.g. a browser
 * session) that must survive a pause.
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type ToolExecuteContext = {
  /** The codemode execution this call belongs to. Stable across pause/resume. */
  executionId: string;
};

/**
 * Terminal outcome of a codemode execution, passed to
 * `CodemodeConnector.disposeExecution`. These mirror the terminal subset of the
 * runtime's `ExecutionStatus`; a `paused` run is *not* terminal — it may resume
 * later — so it is deliberately absent here.
 *
 * - `completed`   — the run finished and returned a result.
 * - `error`       — the run threw or hit a replay divergence.
 * - `rejected`    — a pending action was rejected by the user.
 * - `rolled_back` — the run's applied effects were reverted.
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type ExecutionEndStatus =
  | "completed"
  | "error"
  | "rejected"
  | "rolled_back";

/**
 * Outcome of a single execution *pass*, passed to
 * `CodemodeConnector.onPassEnd`. Unlike `ExecutionEndStatus` this includes
 * `"paused"`: a pass that ends awaiting approval is not terminal (the
 * execution may resume later), but the pass itself is over — per-pass
 * resources (an open socket, a lease) should be released even though
 * per-execution resources (a session) must survive.
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type PassEndStatus = ExecutionEndStatus | "paused";

// ---------------------------------------------------------------------------
// Connector description — returned by describe() RPC.
// ---------------------------------------------------------------------------

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type ConnectorDescription = {
  name: string;
  instructions?: string;
  descriptors: JsonSchemaToolDescriptors;
  annotations?: Record<string, ToolAnnotations>;
};

// ---------------------------------------------------------------------------
// Search result shape — structured, returned by codemode.search inside sandbox.
// ---------------------------------------------------------------------------

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type SearchResult = {
  path: string;
  connector: string;
  method: string;
  description?: string;
  /** Whether invoking this method pauses for approval. */
  requiresApproval?: boolean;
  kind: "method" | "snippet";
  score: number;
};

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type SearchOutput = {
  results: SearchResult[];
  total: number;
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// Describe result shape — returned by codemode.describe inside sandbox.
// ---------------------------------------------------------------------------

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use a host module (`ws:<name>`) on `WorkerJavaScriptBackend`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type DescribeOutput = {
  path: string;
  description?: string;
  /** Whether invoking this method pauses for approval. */
  requiresApproval?: boolean;
  types: string;
  kind: "connector" | "method" | "snippet";
};
