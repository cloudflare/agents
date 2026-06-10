import type { JsonSchemaToolDescriptors } from "../json-schema-types";

// ---------------------------------------------------------------------------
// Annotations — per-method permissions/classification.
// ---------------------------------------------------------------------------

export type ToolAnnotations = {
  /** Requires user approval before executing. Unannotated methods execute immediately. */
  requiresApproval?: boolean;
};

// ---------------------------------------------------------------------------
// Execution lifecycle — context for per-execution resources.
// ---------------------------------------------------------------------------

/**
 * Passed to a tool's `execute`/`revert` so a connector knows which codemode
 * execution the call belongs to. The id is stable across a run's pause/resume
 * passes, so it's the right key for a per-execution resource (e.g. a browser
 * session) that must survive a pause.
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
 */
export type ExecutionEndStatus =
  | "completed"
  | "error"
  | "rejected"
  | "rolled_back";

// ---------------------------------------------------------------------------
// Connector description — returned by describe() RPC.
// ---------------------------------------------------------------------------

export type ConnectorDescription = {
  name: string;
  instructions?: string;
  descriptors: JsonSchemaToolDescriptors;
  annotations?: Record<string, ToolAnnotations>;
};

// ---------------------------------------------------------------------------
// Search result shape — structured, returned by codemode.search inside sandbox.
// ---------------------------------------------------------------------------

export type SearchResult = {
  path: string;
  connector: string;
  method: string;
  description?: string;
  kind: "method" | "snippet";
  score: number;
};

export type SearchOutput = {
  results: SearchResult[];
  total: number;
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// Describe result shape — returned by codemode.describe inside sandbox.
// ---------------------------------------------------------------------------

export type DescribeOutput = {
  path: string;
  description?: string;
  types: string;
  kind: "connector" | "method" | "snippet";
};
