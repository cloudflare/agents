// Keep the generic tracing adapter internal. The public observability surface
// remains diagnostics-channel events plus the focused AI instrumentation
// available from `agents/observability/ai`.
export * from "./events";
