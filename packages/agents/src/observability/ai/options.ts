/** Opt-in span payload storage. Both flags default to `false`. */
export type AISDKStorageOptions = {
  readonly storeMessages?: boolean;
  readonly storeTools?: boolean;
};

export type ResolvedAISDKStorageOptions = {
  readonly storeMessages: boolean;
  readonly storeTools: boolean;
};

/** Instrumentation options for the AI SDK v6 and v7 wrapper. */
export type AISDKInstrumentationOptions = AISDKStorageOptions & {
  /**
   * Context keys to emit as `cloudflare.agents.runtime_context.{key}`, set
   * once for the wrapper rather than per call.
   *
   * Distinct from the AI SDK's own per-call `telemetry.includeRuntimeContext`,
   * which shares the name but selects keys that map onto the canonical
   * `cloudflare.agents.turn.*` / `cloudflare.agents.metadata.*` attributes.
   */
  readonly includeRuntimeContext?: readonly string[];
};
