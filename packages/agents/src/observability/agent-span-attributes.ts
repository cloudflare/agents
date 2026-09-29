import type { TraceAttributes } from "./tracing/tracer";

export function agentSpanAttributes(input: {
  readonly agentClassName: string;
  readonly sessionId: string;
  readonly sessionName: string | undefined;
}): TraceAttributes {
  return {
    // Compatibility representation of InstrumentationScope until the Workers
    // tracing API exposes native scope metadata.
    "instrumentation_scope.name": "agents",
    // Before bumping this telemetry schema version, notify Workers
    // Observability and any other downstream consumers.
    "instrumentation_scope.version": "1",
    "cloudflare.agents.session.id": input.sessionId,
    "cloudflare.agents.session.name": input.sessionName,
    "gen_ai.agent.name": input.agentClassName
  };
}
