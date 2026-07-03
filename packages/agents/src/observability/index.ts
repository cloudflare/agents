// Diagnostics-channel events live in ./events so the main `agents` entry can
// depend on them without initializing the tracer; this public barrel composes
// events + tracing.
export * from "./events";

export type {
  AgentSpan,
  AgentTracer,
  TraceAttributeValue,
  TraceAttributes
} from "./tracing/tracer";
export { tracer } from "./tracing/cloudflare";
