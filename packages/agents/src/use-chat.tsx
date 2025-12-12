/**
 * useChat - Simplified React hook for AI chat with human-in-the-loop support.
 * Combines useAgent + useAgentChat with declarative tool configuration.
 * @module
 */

import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import type { PartySocket } from "partysocket";
import { useCallback, useMemo, useRef } from "react";
import { useAgent } from "./react";
import { useAgentChat, type AITool } from "./ai-react";
import { TOOL_CONFIRMATION, type ToolConfirmationSignal } from "./ai-types";

export { TOOL_CONFIRMATION, type ToolConfirmationSignal };

/**
 * Tool definition with declarative behavior.
 *
 * | execute | confirm | Behavior                    |
 * |---------|---------|---------------------------- |
 * | yes     | false   | Auto-runs on client         |
 * | yes     | true    | User approves, runs client  |
 * | no      | true    | User approves, runs server  |
 * | no      | false   | Auto-runs on server         |
 *
 * Defaults: client tools (has execute) don't require confirm,
 * server tools (no execute) require confirm.
 */
// biome-ignore lint/suspicious/noExplicitAny: Flexible typing for user-defined tool functions
export type Tool<TInput = any, TOutput = any> = {
  /** Description shown to the LLM */
  description?: string;
  /** Client-side execution. If omitted, runs on server. */
  execute?: (input: TInput) => TOutput | Promise<TOutput>;
  /** Whether user approval is required. @default true for server, false for client */
  confirm?: boolean;
};

/** A tool call waiting for user approval */
export type PendingToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  messageId: string;
};

/** Configuration for useChat */
export type UseChatOptions = {
  /** Agent name (Durable Object class binding) */
  agent: string;
  /** Instance name for isolated conversations. @default "default" */
  name?: string;
  /** Tool definitions */
  tools?: Record<string, Tool>;
  /** Error callback */
  onError?: (error: Error) => void;
  /** State change callback */
  onStateUpdate?: (state: unknown, source: "server" | "client") => void;
};

/** Return value from useChat */
export type UseChatHelpers = {
  messages: UIMessage[];
  sendMessage: ReturnType<typeof useAgentChat>["sendMessage"];
  clearHistory: () => void;
  setMessages: ReturnType<typeof useAgentChat>["setMessages"];
  pendingToolCalls: PendingToolCall[];
  approve: (toolCallId: string) => Promise<void>;
  deny: (toolCallId: string, reason?: string) => Promise<void>;
  isLoading: boolean;
  sessionId: string;
  connection: PartySocket;
  error: Error | undefined;
};

function requiresConfirmation(tool: Tool): boolean {
  if (tool.confirm !== undefined) return tool.confirm;
  return !tool.execute;
}

function shouldAutoExecute(tool: Tool): boolean {
  return !!tool.execute && !requiresConfirmation(tool);
}

function toAITools(
  tools: Record<string, Tool> | undefined
): Record<string, AITool> | undefined {
  if (!tools) return undefined;
  const result: Record<string, AITool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    result[name] = { description: tool.description, execute: tool.execute };
  }
  return result;
}

function getToolsRequiringConfirmation(
  tools: Record<string, Tool> | undefined
): string[] {
  if (!tools) return [];
  return Object.entries(tools)
    .filter(([_, tool]) => requiresConfirmation(tool))
    .map(([name]) => name);
}

function hasAutoExecutableTools(
  tools: Record<string, Tool> | undefined
): boolean {
  if (!tools) return false;
  return Object.values(tools).some(shouldAutoExecute);
}

function extractPendingToolCalls(
  messages: UIMessage[],
  toolsRequiringConfirmation: string[]
): PendingToolCall[] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return [];

  const pending: PendingToolCall[] = [];
  for (const part of lastMessage.parts ?? []) {
    if (
      isToolUIPart(part) &&
      part.state === "input-available" &&
      toolsRequiringConfirmation.includes(getToolName(part))
    ) {
      pending.push({
        toolCallId: part.toolCallId,
        toolName: getToolName(part),
        input: part.input,
        messageId: lastMessage.id
      });
    }
  }
  return pending;
}

/**
 * React hook for AI chat with human-in-the-loop tool confirmation.
 *
 * @example
 * ```tsx
 * const { messages, sendMessage, pendingToolCalls, approve, deny } = useChat({
 *   agent: "my-agent",
 *   tools: {
 *     search: { execute: searchFn },
 *     deleteItem: { confirm: true }
 *   }
 * });
 * ```
 */
export function useChat(options: UseChatOptions): UseChatHelpers {
  const {
    agent: agentName,
    name: instanceName,
    tools,
    onError,
    onStateUpdate
  } = options;

  const aiTools = useMemo(() => toAITools(tools), [tools]);
  const toolsRequiringConfirmation = useMemo(
    () => getToolsRequiringConfirmation(tools),
    [tools]
  );
  const enableAutoResolution = useMemo(
    () => hasAutoExecutableTools(tools),
    [tools]
  );

  const agent = useAgent({
    agent: agentName,
    name: instanceName,
    onStateUpdate
  });

  const chat = useAgentChat({
    agent,
    tools: aiTools,
    toolsRequiringConfirmation,
    experimental_automaticToolResolution: enableAutoResolution,
    autoContinueAfterToolResult: true,
    onError
  });

  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  const pendingToolCalls = useMemo(
    () => extractPendingToolCalls(chat.messages, toolsRequiringConfirmation),
    [chat.messages, toolsRequiringConfirmation]
  );

  const pendingRef = useRef(pendingToolCalls);
  pendingRef.current = pendingToolCalls;

  const approve = useCallback(
    async (toolCallId: string): Promise<void> => {
      const pending = pendingRef.current.find(
        (p) => p.toolCallId === toolCallId
      );
      if (!pending) {
        console.warn(`[useChat] No pending tool call found: ${toolCallId}`);
        return;
      }

      const { toolName, input } = pending;
      const tool = toolsRef.current?.[toolName];
      let result: unknown;

      if (tool?.execute) {
        try {
          result = await tool.execute(input);
        } catch (err) {
          result = {
            error: true,
            message: err instanceof Error ? err.message : String(err)
          };
        }
      } else {
        result = TOOL_CONFIRMATION.APPROVED;
      }

      chat.addToolResult({ toolCallId, tool: toolName, output: result });
    },
    [chat.addToolResult]
  );

  const deny = useCallback(
    async (toolCallId: string, reason?: string): Promise<void> => {
      const pending = pendingRef.current.find(
        (p) => p.toolCallId === toolCallId
      );
      const toolName = pending?.toolName ?? "unknown";
      chat.addToolResult({
        toolCallId,
        tool: toolName,
        output: reason ?? TOOL_CONFIRMATION.DENIED
      });
    },
    [chat.addToolResult]
  );

  const clearHistory = useCallback(() => {
    chat.clearHistory();
  }, [chat.clearHistory]);

  return {
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    setMessages: chat.setMessages,
    clearHistory,
    pendingToolCalls,
    approve,
    deny,
    isLoading: chat.status === "streaming" || chat.status === "submitted",
    sessionId: agent.id,
    connection: agent,
    error: chat.error
  };
}
