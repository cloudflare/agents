/**
 * Local trace attribute keys used by the Cloudflare GenAI projection.
 *
 * `gen_ai.*` keys follow OpenTelemetry GenAI semantic conventions where they
 * exist. `ai.*` keys are package-local compatibility attributes for stable
 * dashboards and correlation; they are intentionally not OTel semantic keys.
 */
export const TraceAttribute = {
  AI: {
    EmbeddingCount: "ai.embedding.count",
    EmbeddingDimensions: "ai.embedding.dimensions",
    IntegrationName: "ai.integration.name",
    OperationID: "ai.operation.id",
    OutputHasObject: "ai.output.has_object",
    OutputHasText: "ai.output.has_text",
    ResponseFinishReason: "ai.response.finish_reason",
    ToolCount: "ai.tool.count",
    UsageTotalTokens: "ai.usage.total_tokens",
  },
  GenAI: {
    AgentID: "gen_ai.agent.id",
    AgentName: "gen_ai.agent.name",
    AgentVersion: "gen_ai.agent.version",
    ConversationID: "gen_ai.conversation.id",
    OperationName: "gen_ai.operation.name",
    OperationNameValueChat: "chat",
    OperationNameValueExecuteTool: "execute_tool",
    OperationNameValueInvokeAgent: "invoke_agent",
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
    ResponseFinishReasons: "gen_ai.response.finish_reasons",
    ResponseID: "gen_ai.response.id",
    ResponseModel: "gen_ai.response.model",
    ToolName: "gen_ai.tool.name",
    ToolType: "gen_ai.tool.type",
    UsageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
    UsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
    UsageInputTokens: "gen_ai.usage.input_tokens",
    UsageOutputTokens: "gen_ai.usage.output_tokens",
    UsageReasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens",
  },
} as const;
