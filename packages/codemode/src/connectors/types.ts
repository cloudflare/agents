import type { JsonSchemaToolDescriptors } from "../json-schema-types";

// ---------------------------------------------------------------------------
// Annotations — per-method permissions/classification.
// ---------------------------------------------------------------------------

export type ToolAnnotations = {
  /** Read-only operation. No side effects. */
  observation?: boolean;
  /** Requires user approval before executing. */
  requiresApproval?: boolean;
  /** Human-readable description shown in approval UI. */
  approvalDescription?: string;
};

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
