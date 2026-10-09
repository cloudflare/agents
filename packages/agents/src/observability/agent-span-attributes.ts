import type { TraceAttributes } from "./tracing/tracer";

/**
 * Identifies spans this package emits. A compatibility representation of
 * InstrumentationScope until the Workers tracing API exposes native scope
 * metadata.
 */
export const instrumentationScopeAttributes: TraceAttributes = {
  "instrumentation_scope.name": "agents",
  // Before bumping this telemetry schema version, notify Workers
  // Observability and any other downstream consumers.
  "instrumentation_scope.version": "1"
};

export function agentSpanAttributes(input: {
  readonly agentClassName: string;
  readonly sessionId: string;
  readonly sessionName: string | undefined;
}): TraceAttributes {
  return {
    ...instrumentationScopeAttributes,
    "cloudflare.agents.session.id": input.sessionId,
    "cloudflare.agents.session.name": input.sessionName,
    "gen_ai.agent.name": input.agentClassName
  };
}
