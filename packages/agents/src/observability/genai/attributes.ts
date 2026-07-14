/**
 * Local trace attribute keys used by the Cloudflare GenAI projection.
 *
 * `gen_ai.*` keys follow OpenTelemetry GenAI semantic conventions where they
 * exist (Development status — tracked so spec churn stays an internal edit;
 * none of these constants are exported from the package). Keys with no
 * semconv home live under the `cloudflare.agents.*` vendor namespace — never
 * bare top-level keys, never `ai.*` (the Vercel AI SDK's de-facto namespace).
 */
export const TraceAttribute = {
  Cloudflare: {
    CallID: "cloudflare.agents.call.id",
    IntegrationName: "cloudflare.agents.integration.name",
    MetadataPrefix: "cloudflare.agents.metadata.",
    OperationName: "cloudflare.agents.operation.name",
    ResponseFinishReason: "cloudflare.agents.response.finish_reason",
    ToolCount: "cloudflare.agents.tool.count",
    TurnAdmission: "cloudflare.agents.turn.admission",
    TurnChannel: "cloudflare.agents.turn.channel",
    TurnContinuation: "cloudflare.agents.turn.continuation",
    TurnGeneration: "cloudflare.agents.turn.generation",
    TurnRequestID: "cloudflare.agents.turn.request_id",
    TurnTrigger: "cloudflare.agents.turn.trigger",
    UsageTotalTokens: "cloudflare.agents.usage.total_tokens"
  },
  General: {
    UserID: "user.id"
  },
  GenAI: {
    AgentID: "gen_ai.agent.id",
    AgentName: "gen_ai.agent.name",
    AgentVersion: "gen_ai.agent.version",
    ConversationID: "gen_ai.conversation.id",
    // Opt-in content keys (PII). Emitted only when the caller sets the explicit
    // record flag; never populated on the default privacy-preserving path.
    InputMessages: "gen_ai.input.messages",
    OperationName: "gen_ai.operation.name",
    OperationNameValueChat: "chat",
    OperationNameValueExecuteTool: "execute_tool",
    OperationNameValueInvokeAgent: "invoke_agent",
    OutputMessages: "gen_ai.output.messages",
    OutputType: "gen_ai.output.type",
    ProviderName: "gen_ai.provider.name",
    RequestFrequencyPenalty: "gen_ai.request.frequency_penalty",
    RequestMaxTokens: "gen_ai.request.max_tokens",
    RequestModel: "gen_ai.request.model",
    RequestPresencePenalty: "gen_ai.request.presence_penalty",
    RequestSeed: "gen_ai.request.seed",
    RequestStream: "gen_ai.request.stream",
    RequestTemperature: "gen_ai.request.temperature",
    RequestTopK: "gen_ai.request.top_k",
    RequestTopP: "gen_ai.request.top_p",
    ResponseID: "gen_ai.response.id",
    ResponseModel: "gen_ai.response.model",
    ResponseTimeToFirstChunk: "gen_ai.response.time_to_first_chunk",
    // Opt-in tool content keys (PII), emitted only under the explicit record
    // flag, consistent with the semconv `gen_ai.tool.call.*` execute_tool span.
    ToolCallArguments: "gen_ai.tool.call.arguments",
    ToolCallID: "gen_ai.tool.call.id",
    ToolCallResult: "gen_ai.tool.call.result",
    ToolName: "gen_ai.tool.name",
    ToolType: "gen_ai.tool.type",
    UsageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
    UsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
    UsageInputTokens: "gen_ai.usage.input_tokens",
    UsageOutputTokens: "gen_ai.usage.output_tokens",
    UsageReasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens"
  }
} as const;
