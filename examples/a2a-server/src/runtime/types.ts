import type { AgentCard, Artifact, Task } from "@a2a-js/sdk";

export interface A2AConversationTurn {
  role: "user" | "agent";
  text: string;
}

export interface A2AWorkflowParams {
  /** Missing on Workflow instances persisted before conversation history support. */
  conversation?: A2AConversationTurn[];
  contextId: string;
  prompt: string;
  taskId: string;
  /** Missing on Workflow instances persisted before multi-turn fencing. */
  turn?: number;
}

export interface CurrentA2AWorkflowParams extends A2AWorkflowParams {
  conversation: A2AConversationTurn[];
  turn: number;
}

export interface A2ARuntimeEnv {
  A2A_BEARER_TOKEN?: string;
}

/** Optional server capabilities. Omitted flags default to disabled. */
export interface A2AServerFeatures {
  blockingSend?: boolean;
  completionArtifacts?: boolean;
  intermediateArtifacts?: boolean;
  multiTurn?: boolean;
  streaming?: boolean;
  taskCancellation?: boolean;
  taskListing?: boolean;
}

export type ResolvedA2AServerFeatures = Readonly<Required<A2AServerFeatures>>;

export interface A2ARuntimeOptions<Env extends A2ARuntimeEnv> {
  agentBinding: string;
  agentCard: (origin: string, env: Env) => AgentCard;
  bearerToken: (env: Env) => string;
  contextNamespace: (env: Env) => DurableObjectNamespace;
  ownerName: string;
  maxRequestBytes: number;
  maxTextCharacters?: number;
  /** Final task retention; defaults to 30 days. */
  terminalTaskRetentionMilliseconds?: number;
  features?: A2AServerFeatures;
  workflowName: string;
  completionArtifacts?: (
    response: string,
    metadata: Record<string, unknown>,
    env: Env
  ) => Artifact[];
  onCancel?: (task: Task, env: Env) => Promise<void>;
  unauthorizedResponse: () => Response;
  errors: {
    blockingSendNotSupported?: string;
    streamingNotSupported?: string;
    subscriptionNotSupported?: string;
  };
}

/** Rejects invalid values that TypeScript alone cannot protect at runtime. */
export function validateA2ARuntimeOptions<Env extends A2ARuntimeEnv>(
  options: A2ARuntimeOptions<Env>
): void {
  validateOwnerName(options.ownerName);
  validateBindingName(options.agentBinding, "agentBinding");
  validateBindingName(options.workflowName, "workflowName");
  if (
    !Number.isSafeInteger(options.maxRequestBytes) ||
    options.maxRequestBytes <= 0
  ) {
    throw new Error("maxRequestBytes must be a positive safe integer.");
  }
  if (
    options.maxTextCharacters !== undefined &&
    (!Number.isSafeInteger(options.maxTextCharacters) ||
      options.maxTextCharacters <= 0)
  ) {
    throw new Error(
      "maxTextCharacters must be a positive safe integer when set."
    );
  }
  if (
    options.terminalTaskRetentionMilliseconds !== undefined &&
    (!Number.isSafeInteger(options.terminalTaskRetentionMilliseconds) ||
      options.terminalTaskRetentionMilliseconds <= 0)
  ) {
    throw new Error(
      "terminalTaskRetentionMilliseconds must be a positive safe integer when set."
    );
  }
}

function validateBindingName(value: unknown, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

/** Validates the durable ownership key used to scope all task reads and writes. */
export function validateOwnerName(
  ownerName: unknown
): asserts ownerName is string {
  if (typeof ownerName !== "string" || ownerName.trim().length === 0) {
    throw new Error("ownerName must be a non-empty string.");
  }
}

/** Restores fields absent from already-persisted first-turn Workflow payloads. */
export function normalizeA2AWorkflowParams(
  params: A2AWorkflowParams
): CurrentA2AWorkflowParams {
  if (
    typeof params.contextId !== "string" ||
    typeof params.taskId !== "string" ||
    typeof params.prompt !== "string"
  ) {
    throw new Error("Workflow parameters contain invalid string fields.");
  }
  const turn = params.turn ?? 1;
  if (!Number.isSafeInteger(turn) || turn <= 0) {
    throw new Error("Workflow turn must be a positive safe integer.");
  }
  const conversation = params.conversation ?? [
    { role: "user" as const, text: params.prompt }
  ];
  if (
    !Array.isArray(conversation) ||
    conversation.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        (item.role !== "user" && item.role !== "agent") ||
        typeof item.text !== "string"
    )
  ) {
    throw new Error("Workflow conversation is invalid.");
  }
  return { ...params, conversation, turn };
}
