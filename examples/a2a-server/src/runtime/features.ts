import { AgentCard } from "@a2a-js/sdk";
import type { A2AServerFeatures, ResolvedA2AServerFeatures } from "./types";

/** Resolves omitted server capabilities to the core-only disabled state. */
export function resolveA2AServerFeatures(
  features: A2AServerFeatures = {}
): ResolvedA2AServerFeatures {
  return Object.freeze({
    blockingSend: features.blockingSend === true,
    completionArtifacts: features.completionArtifacts === true,
    intermediateArtifacts: features.intermediateArtifacts === true,
    multiTurn: features.multiTurn === true,
    streaming: features.streaming === true,
    taskCancellation: features.taskCancellation === true,
    taskListing: features.taskListing === true
  });
}

/** Applies runtime-owned capability flags to an application's base Agent Card. */
export function applyA2AServerFeatures(
  base: AgentCard,
  features: ResolvedA2AServerFeatures
): AgentCard {
  const card = AgentCard.fromJSON(AgentCard.toJSON(base));
  card.capabilities = {
    ...(card.capabilities ?? { extensions: [] }),
    streaming: features.streaming,
    pushNotifications: false,
    extendedAgentCard: false
  };
  return card;
}
