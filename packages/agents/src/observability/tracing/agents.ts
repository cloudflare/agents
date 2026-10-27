import { trace } from "@opentelemetry/api";
import type { Context, Span, SpanOptions, Tracer } from "@opentelemetry/api";
import { ensureOpenTelemetry } from "../otel";
import { createTracer } from "./tracer";
import type { AgentTracer } from "./tracer";

/**
 * The Agents SDK's OpenTelemetry tracer. A `ProxyTracer` from the global API,
 * so it follows whatever provider is registered: the Workers tracing bridge,
 * an application's own OpenTelemetry SDK, or (later) the runtime's native
 * OpenTelemetry support. With nothing registered, spans are no-ops.
 */
const scope = trace.getTracer("agents");

/** Registers the Workers tracing bridge on first use, then defers to `scope`. */
const agentsTracer: Tracer = {
  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    ensureOpenTelemetry();
    return scope.startSpan(name, options, context);
  },
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    ...rest: [F] | [SpanOptions, F] | [SpanOptions, Context, F]
  ): ReturnType<F> {
    ensureOpenTelemetry();
    return Reflect.apply(scope.startActiveSpan, scope, [
      name,
      ...rest
    ]) as ReturnType<F>;
  }
};

export const tracer: AgentTracer = createTracer(agentsTracer);
