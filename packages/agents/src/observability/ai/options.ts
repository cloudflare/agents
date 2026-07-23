/** Opt-in span payload storage. Both flags default to `false`. */
export type AISDKStorageOptions = {
  readonly storeMessages?: boolean;
  readonly storeTools?: boolean;
};

export type ResolvedAISDKStorageOptions = {
  readonly storeMessages: boolean;
  readonly storeTools: boolean;
};

/** Instrumentation options for the AI SDK v6 adapter. */
export type AISDKInstrumentationOptions = AISDKStorageOptions & {
  /** AI SDK v6 `experimental_context` keys to emit as scalar attributes. */
  readonly includeRuntimeContext?: readonly string[];
};
