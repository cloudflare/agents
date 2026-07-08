/** Instrumentation options for the AI SDK v6 adapter. */
export type AISDKInstrumentationOptions = {
  /** AI SDK v6 `experimental_context` keys to emit as scalar attributes. */
  readonly includeRuntimeContext?: readonly string[];
};
