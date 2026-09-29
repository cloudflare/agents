import type { Artifact } from "@a2a-js/sdk";
import { Agent } from "agents";
import type { AgentContext } from "agents";
import { createA2AContextDO } from "./runtime/index";
import { coordinatorOptions, specialistOptions } from "./runtime";

interface A2ATaskAgentRpc {
  completeTask(
    taskId: string,
    response: string,
    artifacts?: Artifact[],
    metadata?: Record<string, unknown>,
    turn?: number
  ): void;
  failTask(taskId: string, reason: string, turn?: number): void;
  publishTaskArtifact(
    taskId: string,
    artifact: Artifact,
    turn?: number,
    publicationId?: string
  ): Promise<void>;
  requireInput(taskId: string, question: string, turn?: number): void;
}

type ConcreteAgentClass = new (
  ctx: AgentContext,
  env: Cloudflare.Env
) => Agent<Cloudflare.Env> & A2ATaskAgentRpc;

// Erase the factory return here to avoid recursively expanding Wrangler's
// generated Env, which refers back to these exported Durable Object classes.
const createConcreteAgent = createA2AContextDO as unknown as (
  options: unknown
) => ConcreteAgentClass;
const CoordinatorAgentBase: ConcreteAgentClass =
  createConcreteAgent(coordinatorOptions);
const SpecialistAgentBase: ConcreteAgentClass =
  createConcreteAgent(specialistOptions);

export class CoordinatorAgent extends CoordinatorAgentBase {}

export class SpecialistAgent extends SpecialistAgentBase {}
