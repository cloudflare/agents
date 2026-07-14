/**
 * Opt-in span content recording. Both default to `false`; when set to `true`
 * the adapter serializes raw prompts/messages (`recordInputs`) and model output
 * plus tool results (`recordOutputs`) onto spans. This content is potentially
 * PII, so it is emitted ONLY when the flag is explicitly `true`. The option
 * names mirror the AI SDK's own `TelemetrySettings.recordInputs`/`recordOutputs`.
 */
export type ContentRecordingOptions = {
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
};

/** Instrumentation options for the AI SDK v6 adapter. */
export type AISDKInstrumentationOptions = ContentRecordingOptions & {
  /** AI SDK v6 `experimental_context` keys to emit as scalar attributes. */
  readonly includeRuntimeContext?: readonly string[];
};
