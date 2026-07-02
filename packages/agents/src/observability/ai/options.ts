/** Instrumentation options for the AI SDK adapter. */
export type AISDKInstrumentationOptions = {
  readonly includeRuntimeContext?: readonly string[];
  readonly includeToolsContext?: Readonly<Record<string, readonly string[]>>;
};
