import type { A2ARuntimeEnv, A2ARuntimeOptions } from "./runtime/index";
import { buildAgentCard } from "./agent-card";
import { unauthorizedResponse } from "./auth";

interface ServerRuntimeEnv extends A2ARuntimeEnv {
  COORDINATOR: DurableObjectNamespace;
  SPECIALIST: DurableObjectNamespace;
}

const features = {
  blockingSend: true,
  completionArtifacts: true,
  intermediateArtifacts: true,
  multiTurn: true,
  streaming: true,
  taskCancellation: true,
  taskListing: true
} as const;

const sharedOptions = {
  bearerToken: requireBearerToken,
  maxRequestBytes: 1024 * 1024,
  features,
  unauthorizedResponse,
  errors: {}
};

export const coordinatorOptions: A2ARuntimeOptions<ServerRuntimeEnv> = {
  ...sharedOptions,
  maxTextCharacters: 60 * 1024,
  agentBinding: "COORDINATOR",
  agentCard: (origin) =>
    buildAgentCard(origin, {
      name: "Coordinator Agent",
      description:
        "Drafts a response, asks the Specialist Agent to challenge it, and returns their joint result.",
      route: "coordinator",
      skillId: "coordinate-specialist-review"
    }),
  contextNamespace: (env) => env.COORDINATOR,
  ownerName: "coordinator-client",
  workflowName: "COORDINATOR_TASK_WORKFLOW"
};

export const specialistOptions: A2ARuntimeOptions<ServerRuntimeEnv> = {
  ...sharedOptions,
  maxTextCharacters: 64 * 1024,
  agentBinding: "SPECIALIST",
  agentCard: (origin) =>
    buildAgentCard(origin, {
      name: "Specialist Agent",
      description:
        "Challenges a coordinator draft once, then produces a deterministic joint answer.",
      route: "specialist",
      skillId: "challenge-and-revise"
    }),
  contextNamespace: (env) => env.SPECIALIST,
  ownerName: "specialist-client",
  workflowName: "SPECIALIST_TASK_WORKFLOW"
};

export function requireBearerToken(env: object): string {
  const token = "A2A_BEARER_TOKEN" in env ? env.A2A_BEARER_TOKEN : undefined;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("A2A_BEARER_TOKEN is required.");
  }
  return token;
}
