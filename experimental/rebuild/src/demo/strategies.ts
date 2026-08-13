/**
 * Demo strategies for the remaining seams — each one deliberately tiny, so
 * the demo point lands: swapping a strategy is swapping a value.
 *
 * - goldfish / elephant : ContextAssembler (how much the model SEES;
 *                         the log keeps everything either way)
 * - patient / impatient : AdmissionPolicy (queue vs latest-wins preempt)
 * - nanny               : ToolMiddleware (conditional approval, ADR 0004 style)
 */

import type {
  AdmissionPolicy,
  ContextAssembler,
  MessagePayload,
  ToolMiddleware
} from "../contract";
import { windowAssembler } from "../context/window-assembler";
import { defaultAdmission } from "../admission/default";

const SYSTEM = "You are a helpful demo agent.";

/** Sees only the last two messages. Forgets your name. The log does not. */
export function goldfish(): ContextAssembler {
  return windowAssembler({ system: SYSTEM, windowSize: 2 });
}

/** Sees everything. Swap goldfish→elephant and the "lost" memory returns. */
export function elephant(): ContextAssembler {
  return windowAssembler({ system: SYSTEM, windowSize: 200 });
}

/** Queue behind the active turn (the default). */
export function patient(): AdmissionPolicy {
  return defaultAdmission();
}

/** Latest-wins: a new user message preempts the in-flight turn. */
export function impatient(): AdmissionPolicy {
  const base = defaultAdmission();
  return {
    triggers: base.triggers,
    decide(input) {
      const decision = base.decide(input);
      if (
        decision.action === "queue" &&
        (input.entry.payload as MessagePayload).role === "user" &&
        input.active !== undefined &&
        input.active.status === "active"
      ) {
        return { action: "preempt" };
      }
      return decision;
    }
  };
}

/**
 * The nanny: rewrites tool descriptors so the named tools require approval.
 * Conditional approval as middleware — the descriptor keeps the unconditional
 * truth; authority composes here.
 */
export function nanny(gated: readonly string[]): ToolMiddleware {
  return (next) => ({
    name: `nanny(${next.name})`,
    resources: next.resources ?? [],
    async catalog() {
      const catalog = await next.catalog();
      return catalog.map((d) =>
        gated.includes(d.name)
          ? {
              ...d,
              approval: {
                mode: "always" as const,
                describe: (input: unknown) => ({
                  title: `The nanny requires sign-off for ${d.name}`,
                  detail: "Gambling and fortune-telling are supervised activities.",
                  input: input as never
                })
              }
            }
          : d
      );
    },
    execute: (call, deps) => next.execute(call, deps)
  });
}
