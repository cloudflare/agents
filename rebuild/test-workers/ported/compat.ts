/**
 * Compat shim for ported original tests (audit 29 §2).
 *
 * Ported test files re-point their `agents` / `partyserver` /
 * `@cloudflare/think` imports at this single module, which maps each name
 * onto the rebuilt surface. Grow it per ported file — never let a ported
 * test import rebuild internals directly (the shim IS the documented compat
 * surface).
 */
import type { DurableObjectStub } from "@cloudflare/workers-types";
import { getAgentByName as rebuiltGetAgentByName, routeAgentRequest } from "../../src/adapters/cloudflare/routing.js";

export { routeAgentRequest };

/** Original `agents` export. The rebuilt version is async (it __init's the name). */
export const getAgentByName = rebuiltGetAgentByName;

/** partyserver's older equivalent — same semantics for test purposes. */
export const getServerByName = rebuiltGetAgentByName;

/**
 * `agents/observability` subscribe. Not bridged yet (ISSUE-009) — ported
 * tests that assert observability events fail here with a clear triage
 * signal rather than a confusing frame mismatch.
 */
export function subscribe(..._args: unknown[]): () => void {
  throw new Error("observability bridge not implemented — ISSUE-009 (triage: missing-feature)");
}

/**
 * Type re-exports the original test files reference from the think package.
 * Map to rebuilt equivalents as ports need them; add aliases here, not casts
 * in test files.
 */
export type {
  ChatResponseResult,
  TurnResult,
  StreamCallback,
  ChatErrorContext,
} from "../../src/app/think.js";
export { Think } from "../../src/app/think.js";
export { action } from "../../src/domain/actions/actions.js";
export type { AgentHost } from "../../src/app/agent.js";
export { hostAgent } from "../../src/adapters/cloudflare/shell.js";

/** Convenience for fixtures: typed stub with the shell's RPC surface. */
export type AgentStub = DurableObjectStub & {
  __call<T = unknown>(method: string, args: unknown[]): Promise<T>;
  __init(init: { name: string }): Promise<void>;
  __destroy(): Promise<void>;
};
