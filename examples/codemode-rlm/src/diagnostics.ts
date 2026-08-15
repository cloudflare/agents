export type MessageDiagnostics = {
  messageCount: number;
  assistantMessageCount: number;
  modelStepCount: number;
  toolCallCount: number;
  toolNames: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reduce a Think transcript to count-only evaluation diagnostics. */
export function summarizeMessages(messagesValue: unknown): MessageDiagnostics {
  const messages = Array.isArray(messagesValue) ? messagesValue : [];
  let assistantMessageCount = 0;
  let modelStepCount = 0;
  const toolCallIds = new Set<string>();
  const toolNames = new Set<string>();

  for (const [messageIndex, message] of messages.entries()) {
    const messageRecord = record(message);
    if (messageRecord?.role !== "assistant") continue;
    assistantMessageCount += 1;
    if (!Array.isArray(messageRecord.parts)) continue;
    for (const [partIndex, part] of messageRecord.parts.entries()) {
      const partRecord = record(part);
      if (!partRecord) continue;
      if (partRecord.type === "step-start") modelStepCount += 1;
      if (typeof partRecord.type !== "string") continue;
      const dynamic = partRecord.type === "dynamic-tool";
      if (!dynamic && !partRecord.type.startsWith("tool-")) continue;
      const toolName = dynamic
        ? partRecord.toolName
        : partRecord.type.slice("tool-".length);
      if (typeof toolName === "string" && toolName) toolNames.add(toolName);
      toolCallIds.add(
        typeof partRecord.toolCallId === "string"
          ? partRecord.toolCallId
          : `${messageIndex}:${partIndex}`
      );
    }
  }

  return {
    messageCount: messages.length,
    assistantMessageCount,
    modelStepCount,
    toolCallCount: toolCallIds.size,
    toolNames: [...toolNames].sort()
  };
}

/** Validate the count-only envelope received by the local Node evaluation runner. */
export function parseMessageDiagnostics(value: unknown): MessageDiagnostics {
  const valueRecord = record(value);
  if (!valueRecord) throw new Error("diagnostics response must be an object");
  const integer = (key: keyof MessageDiagnostics): number => {
    const candidate = valueRecord[key];
    if (!Number.isInteger(candidate) || (candidate as number) < 0) {
      throw new Error(`diagnostics.${key} must be a non-negative integer`);
    }
    return candidate as number;
  };
  if (
    !Array.isArray(valueRecord.toolNames) ||
    !valueRecord.toolNames.every((name) => typeof name === "string")
  ) {
    throw new Error("diagnostics.toolNames must be a string array");
  }
  return {
    messageCount: integer("messageCount"),
    assistantMessageCount: integer("assistantMessageCount"),
    modelStepCount: integer("modelStepCount"),
    toolCallCount: integer("toolCallCount"),
    toolNames: [...new Set(valueRecord.toolNames)].sort()
  };
}
