/**
 * useChat - A simplified React hook for AI chat with human-in-the-loop support.
 *
 * This hook provides a cleaner API over useAgent + useAgentChat by:
 * - Combining two hooks into one
 * - Using declarative tool configuration
 * - Providing simple approve/deny functions for tool confirmations
 *
 * @module
 */

import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import type { PartySocket } from "partysocket";
import { useCallback, useMemo, useRef } from "react";
import { useAgent } from "./react";
import { useAgentChat, type AITool } from "./ai-react";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Protocol constants for tool confirmation.
 * These match the server-side expectations in AIChatAgent.
 */
export const TOOL_CONFIRMATION = {
  /** Signal sent to server when user approves a tool call */
  APPROVED: "Yes, confirmed.",
  /** Signal sent to server when user denies a tool call */
  DENIED: "No, denied."
} as const;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Tool definition with declarative behavior configuration.
 *
 * The combination of `execute` and `confirm` determines tool behavior:
 *
 * | execute | confirm | Behavior |
 * |---------|---------|----------|
 * | yes     | false (default) | Auto-executes on client |
 * | yes     | true    | Requires approval, then executes on client |
 * | no      | true (default)  | Requires approval, server executes |
 * | no      | false   | Server auto-executes |
 *
 * @example
 * ```ts
 * const tools = {
 *   // Client tool, auto-executes
 *   calculator: {
 *     description: "Evaluate math expressions",
 *     execute: async ({ expr }) => eval(expr)
 *   },
 *   // Client tool, requires approval
 *   sendEmail: {
 *     description: "Send an email",
 *     execute: async (input) => sendEmail(input),
 *     confirm: true
 *   },
 *   // Server tool, requires approval (default)
 *   deleteFile: {
 *     description: "Delete a file from storage"
 *   },
 *   // Server tool, auto-executes
 *   getWeather: {
 *     description: "Get current weather",
 *     confirm: false
 *   }
 * };
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Flexible typing needed for user-defined tool functions
export type Tool<TInput = any, TOutput = any> = {
  /** Human-readable description of what the tool does */
  description?: string;

  /**
   * Client-side execution function.
   * If omitted, the tool runs on the server.
   */
  execute?: (input: TInput) => TOutput | Promise<TOutput>;

  /**
   * Whether user approval is required before execution.
   * @default true for server tools (no execute), false for client tools (has execute)
   */
  confirm?: boolean;
};

/**
 * Represents a tool call that is waiting for user approval.
 */
export type PendingToolCall = {
  /** Unique identifier for this tool invocation */
  toolCallId: string;
  /** Name of the tool being called */
  toolName: string;
  /** Input arguments for the tool */
  input: unknown;
  /** ID of the message containing this tool call */
  messageId: string;
};

/**
 * Configuration options for useChat.
 */
export type UseChatOptions = {
  /**
   * Agent name - the Durable Object class binding name.
   * Will be converted to kebab-case for the URL.
   */
  agent: string;

  /**
   * Instance name for separate chat sessions.
   * Different names create isolated conversations.
   * @default "default"
   */
  name?: string;

  /**
   * Tool definitions with declarative configuration.
   * Tools can execute on client or server, with optional user confirmation.
   */
  tools?: Record<string, Tool>;

  /**
   * Callback when an error occurs.
   */
  onError?: (error: Error) => void;

  /**
   * Callback when agent state updates.
   */
  onStateUpdate?: (state: unknown, source: "server" | "client") => void;
};

/**
 * Return value from useChat hook.
 */
export type UseChatHelpers = {
  /** Current chat messages */
  messages: UIMessage[];

  /** Send a new message */
  sendMessage: ReturnType<typeof useAgentChat>["sendMessage"];

  /** Clear all chat history */
  clearHistory: () => void;

  /** Set messages directly */
  setMessages: ReturnType<typeof useAgentChat>["setMessages"];

  /** Tool calls awaiting user approval */
  pendingToolCalls: PendingToolCall[];

  /**
   * Approve a pending tool call.
   * For client tools: executes the tool and sends result to server.
   * For server tools: sends approval signal to server.
   */
  approve: (toolCallId: string) => Promise<void>;

  /**
   * Deny a pending tool call.
   * @param toolCallId - The tool call to deny
   * @param reason - Optional reason for denial (sent to server)
   */
  deny: (toolCallId: string, reason?: string) => Promise<void>;

  /** Unique session identifier */
  sessionId: string;

  /** Raw WebSocket connection (escape hatch for advanced use) */
  connection: PartySocket;

  /** Current error, if any */
  error: Error | undefined;
};

// =============================================================================
// INTERNAL UTILITIES
// =============================================================================

/**
 * Determines if a tool requires user confirmation based on its config.
 */
function requiresConfirmation(tool: Tool): boolean {
  if (tool.confirm !== undefined) {
    return tool.confirm;
  }
  // Default: server tools (no execute) require confirmation
  return !tool.execute;
}

/**
 * Determines if a tool should auto-execute on the client.
 */
function isAutoExecutable(tool: Tool): boolean {
  // Must have execute function and not require confirmation
  return !!tool.execute && !requiresConfirmation(tool);
}

/**
 * Converts our Tool format to AITool format for useAgentChat.
 */
function toAITools(
  tools: Record<string, Tool> | undefined
): Record<string, AITool> | undefined {
  if (!tools) return undefined;

  const result: Record<string, AITool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    result[name] = {
      description: tool.description,
      execute: tool.execute
    };
  }
  return result;
}

/**
 * Extracts tool names that require confirmation.
 */
function getConfirmationRequired(
  tools: Record<string, Tool> | undefined
): string[] {
  if (!tools) return [];
  return Object.entries(tools)
    .filter(([_, tool]) => requiresConfirmation(tool))
    .map(([name]) => name);
}

/**
 * Checks if any tools should auto-execute.
 */
function hasAutoExecutableTools(
  tools: Record<string, Tool> | undefined
): boolean {
  if (!tools) return false;
  return Object.values(tools).some(isAutoExecutable);
}

/**
 * Extracts pending tool calls from the last assistant message.
 */
function extractPendingToolCalls(
  messages: UIMessage[],
  confirmationRequired: string[]
): PendingToolCall[] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") {
    return [];
  }

  const pending: PendingToolCall[] = [];
  for (const part of lastMessage.parts ?? []) {
    if (
      isToolUIPart(part) &&
      part.state === "input-available" &&
      confirmationRequired.includes(getToolName(part))
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

// =============================================================================
// HOOK
// =============================================================================

/**
 * React hook for building AI chat interfaces with human-in-the-loop support.
 *
 * Combines useAgent and useAgentChat into a single hook with a cleaner API
 * for handling tool confirmations.
 *
 * @example
 * ```tsx
 * function Chat() {
 *   const {
 *     messages,
 *     sendMessage,
 *     pendingToolCalls,
 *     approve,
 *     deny
 *   } = useChat({
 *     agent: "my-agent",
 *     tools: {
 *       search: { execute: searchFn },
 *       deleteItem: { confirm: true }
 *     }
 *   });
 *
 *   return (
 *     <div>
 *       {messages.map(m => <Message key={m.id} message={m} />)}
 *
 *       {pendingToolCalls.map(({ toolCallId, toolName, input }) => (
 *         <ToolConfirmation
 *           key={toolCallId}
 *           toolName={toolName}
 *           input={input}
 *           onApprove={() => approve(toolCallId)}
 *           onDeny={() => deny(toolCallId)}
 *         />
 *       ))}
 *
 *       <ChatInput onSend={(text) => sendMessage({ text })} />
 *     </div>
 *   );
 * }
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

  // Memoize derived tool configurations
  const aiTools = useMemo(() => toAITools(tools), [tools]);
  const confirmationRequired = useMemo(
    () => getConfirmationRequired(tools),
    [tools]
  );
  const enableAutoResolution = useMemo(
    () => hasAutoExecutableTools(tools),
    [tools]
  );

  // Create agent connection
  const agent = useAgent({
    agent: agentName,
    name: instanceName,
    onStateUpdate
  });

  // Use underlying chat functionality
  const chat = useAgentChat({
    agent,
    tools: aiTools,
    toolsRequiringConfirmation: confirmationRequired,
    experimental_automaticToolResolution: enableAutoResolution,
    autoContinueAfterToolResult: true,
    onError
  });

  // Keep a ref to tools for use in callbacks without causing re-renders
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  // Extract pending tool calls from messages
  const pendingToolCalls = useMemo(
    () => extractPendingToolCalls(chat.messages, confirmationRequired),
    [chat.messages, confirmationRequired]
  );

  // Keep ref for use in callbacks
  const pendingRef = useRef(pendingToolCalls);
  pendingRef.current = pendingToolCalls;

  /**
   * Approve a tool call - executes client tools or sends approval to server.
   */
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

      let output: unknown;

      if (tool?.execute) {
        // Client-side tool: execute locally
        try {
          output = await tool.execute(input);
        } catch (err) {
          output = {
            error: true,
            message: err instanceof Error ? err.message : String(err)
          };
        }
      } else {
        // Server-side tool: send approval signal
        output = TOOL_CONFIRMATION.APPROVED;
      }

      chat.addToolResult({ toolCallId, tool: toolName, output });
    },
    [chat.addToolResult]
  );

  /**
   * Deny a tool call.
   */
  const deny = useCallback(
    async (toolCallId: string, reason?: string): Promise<void> => {
      const pending = pendingRef.current.find(
        (p) => p.toolCallId === toolCallId
      );
      const toolName = pending?.toolName ?? "unknown";
      const output = reason ?? TOOL_CONFIRMATION.DENIED;

      chat.addToolResult({ toolCallId, tool: toolName, output });
    },
    [chat.addToolResult]
  );

  /**
   * Clear chat history.
   */
  const clearHistory = useCallback(() => {
    chat.clearHistory();
  }, [chat.clearHistory]);

  return {
    // Message state
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    setMessages: chat.setMessages,
    clearHistory,

    // Tool confirmation
    pendingToolCalls,
    approve,
    deny,

    // Connection info
    sessionId: agent.id,
    connection: agent,

    // Error state
    error: chat.error
  };
}

// =============================================================================
// RE-EXPORTS FOR CONVENIENCE
// =============================================================================

// Re-export for backwards compatibility with previous API naming
export type { PendingToolCall as PendingConfirmation };
