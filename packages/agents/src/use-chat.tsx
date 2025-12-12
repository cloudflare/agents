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
import { TOOL_CONFIRMATION, type ToolConfirmationSignal } from "./ai-types";

// Re-export for convenience (so users can import from "agents/react")
export { TOOL_CONFIRMATION, type ToolConfirmationSignal };

// =============================================================================
// TYPES
// =============================================================================

/**
 * Client-side tool definition with declarative behavior configuration.
 *
 * ## Execution Model
 *
 * Tools can run on the **client** (browser) or **server** (Cloudflare Worker),
 * with optional user confirmation before execution:
 *
 * | Property    | execute | confirm | Behavior                              |
 * |-------------|---------|---------|---------------------------------------|
 * | Client auto | yes     | false   | Runs immediately on client            |
 * | Client HITL | yes     | true    | User confirms, then runs on client    |
 * | Server HITL | no      | true    | User confirms, then runs on server    |
 * | Server auto | no      | false   | Runs immediately on server            |
 *
 * ## Defaults
 * - Client tools (`execute` provided): `confirm` defaults to `false`
 * - Server tools (no `execute`): `confirm` defaults to `true`
 *
 * @example
 * ```ts
 * const tools: Record<string, Tool> = {
 *   // Client tool - auto-executes (safe operation)
 *   calculator: {
 *     execute: async ({ expr }) => eval(expr)
 *   },
 *
 *   // Client tool - requires approval (sensitive operation)
 *   sendEmail: {
 *     execute: async (input) => emailService.send(input),
 *     confirm: true
 *   },
 *
 *   // Server tool - requires approval (default for server tools)
 *   deleteFile: {
 *     description: "Permanently delete a file"
 *     // No execute = server handles it after user approval
 *   },
 *
 *   // Server tool - auto-executes (safe read operation)
 *   getWeather: {
 *     confirm: false
 *     // Server runs immediately without asking user
 *   }
 * };
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Flexible typing for user-defined tool functions
export type Tool<TInput = any, TOutput = any> = {
  /**
   * Human-readable description shown to the LLM.
   * Helps the model understand when to use this tool.
   */
  description?: string;

  /**
   * Client-side execution function.
   *
   * - If provided: Tool runs in the browser
   * - If omitted: Tool runs on the server (Worker)
   */
  execute?: (input: TInput) => TOutput | Promise<TOutput>;

  /**
   * Whether user approval is required before execution.
   *
   * @default true for server tools, false for client tools
   */
  confirm?: boolean;
};

/**
 * A tool call waiting for user approval.
 *
 * Rendered in UI to let users review and approve/deny tool execution.
 */
export type PendingToolCall = {
  /** Unique identifier for this specific tool invocation */
  toolCallId: string;
  /** Name of the tool (matches key in tools config) */
  toolName: string;
  /** Arguments the LLM wants to pass to the tool */
  input: unknown;
  /** ID of the assistant message containing this tool call */
  messageId: string;
};

/**
 * Configuration for the useChat hook.
 */
export type UseChatOptions = {
  /**
   * Agent name - matches your Durable Object class binding.
   *
   * @example "ChatAgent" or "my-chat-agent"
   */
  agent: string;

  /**
   * Instance name for isolated conversations.
   *
   * Different names create separate chat histories.
   * @default "default"
   */
  name?: string;

  /**
   * Tool definitions for this chat session.
   *
   * @see Tool for configuration options
   */
  tools?: Record<string, Tool>;

  /** Called when an error occurs during chat operations */
  onError?: (error: Error) => void;

  /** Called when the agent's state changes */
  onStateUpdate?: (state: unknown, source: "server" | "client") => void;
};

/**
 * Return value from the useChat hook.
 */
export type UseChatHelpers = {
  /** All messages in the conversation */
  messages: UIMessage[];

  /** Send a new message to the agent */
  sendMessage: ReturnType<typeof useAgentChat>["sendMessage"];

  /** Clear all message history */
  clearHistory: () => void;

  /** Directly set the messages array */
  setMessages: ReturnType<typeof useAgentChat>["setMessages"];

  /** Tool calls waiting for user approval */
  pendingToolCalls: PendingToolCall[];

  /**
   * Approve a tool call.
   *
   * - Client tools: Executes locally, sends result to server
   * - Server tools: Sends approval signal, server executes
   */
  approve: (toolCallId: string) => Promise<void>;

  /**
   * Deny a tool call.
   *
   * @param toolCallId - Which tool call to deny
   * @param reason - Optional custom denial message
   */
  deny: (toolCallId: string, reason?: string) => Promise<void>;

  /** Whether the assistant is currently generating a response */
  isLoading: boolean;

  /** Unique identifier for this chat session */
  sessionId: string;

  /** Raw WebSocket connection for advanced use cases */
  connection: PartySocket;

  /** Current error, if any */
  error: Error | undefined;
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Checks if a tool requires user confirmation.
 *
 * Logic:
 * - Explicit `confirm: true/false` takes precedence
 * - Otherwise: server tools (no execute) default to requiring confirmation
 */
function requiresConfirmation(tool: Tool): boolean {
  if (tool.confirm !== undefined) {
    return tool.confirm;
  }
  // Default: server tools require confirmation, client tools don't
  return !tool.execute;
}

/**
 * Checks if a tool should auto-execute on the client.
 * Must have execute function AND not require confirmation.
 */
function shouldAutoExecute(tool: Tool): boolean {
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
 * Gets list of tool names that require user confirmation.
 */
function getToolsRequiringConfirmation(
  tools: Record<string, Tool> | undefined
): string[] {
  if (!tools) return [];
  return Object.entries(tools)
    .filter(([_, tool]) => requiresConfirmation(tool))
    .map(([name]) => name);
}

/**
 * Checks if any tools support auto-execution.
 */
function hasAutoExecutableTools(
  tools: Record<string, Tool> | undefined
): boolean {
  if (!tools) return false;
  return Object.values(tools).some(shouldAutoExecute);
}

/**
 * Extracts pending tool calls from messages.
 *
 * Looks at the last assistant message for tool invocations that:
 * 1. Are in "input-available" state (waiting for response)
 * 2. Are in the list of tools requiring confirmation
 */
function extractPendingToolCalls(
  messages: UIMessage[],
  toolsRequiringConfirmation: string[]
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

// =============================================================================
// HOOK
// =============================================================================

/**
 * React hook for building AI chat interfaces with human-in-the-loop support.
 *
 * Combines connection management and chat functionality into a single hook
 * with a declarative API for tool configuration.
 *
 * @example
 * ```tsx
 * function ChatUI() {
 *   const {
 *     messages,
 *     sendMessage,
 *     pendingToolCalls,
 *     approve,
 *     deny,
 *     isLoading
 *   } = useChat({
 *     agent: "my-agent",
 *     tools: {
 *       search: { execute: searchFn },        // Client, auto-execute
 *       deleteItem: { confirm: true }         // Server, needs approval
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
 *           name={toolName}
 *           args={input}
 *           onApprove={() => approve(toolCallId)}
 *           onDeny={() => deny(toolCallId)}
 *         />
 *       ))}
 *
 *       <input
 *         disabled={isLoading}
 *         onKeyDown={e => {
 *           if (e.key === 'Enter') {
 *             sendMessage({ prompt: e.currentTarget.value });
 *           }
 *         }}
 *       />
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

  // Memoize derived tool configurations to avoid recalculating on every render
  const aiTools = useMemo(() => toAITools(tools), [tools]);
  const toolsRequiringConfirmation = useMemo(
    () => getToolsRequiringConfirmation(tools),
    [tools]
  );
  const enableAutoResolution = useMemo(
    () => hasAutoExecutableTools(tools),
    [tools]
  );

  // Establish WebSocket connection to the agent
  const agent = useAgent({
    agent: agentName,
    name: instanceName,
    onStateUpdate
  });

  // Use the underlying chat hook with our derived configuration
  const chat = useAgentChat({
    agent,
    tools: aiTools,
    toolsRequiringConfirmation,
    experimental_automaticToolResolution: enableAutoResolution,
    autoContinueAfterToolResult: true,
    onError
  });

  // Refs to avoid stale closures in callbacks
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  // Extract pending tool calls from current messages
  const pendingToolCalls = useMemo(
    () => extractPendingToolCalls(chat.messages, toolsRequiringConfirmation),
    [chat.messages, toolsRequiringConfirmation]
  );

  const pendingRef = useRef(pendingToolCalls);
  pendingRef.current = pendingToolCalls;

  /**
   * Approve a pending tool call.
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

      let result: unknown;

      if (tool?.execute) {
        // Client tool: execute locally and send result
        try {
          result = await tool.execute(input);
        } catch (err) {
          result = {
            error: true,
            message: err instanceof Error ? err.message : String(err)
          };
        }
      } else {
        // Server tool: send approval signal
        result = TOOL_CONFIRMATION.APPROVED;
      }

      chat.addToolResult({ toolCallId, tool: toolName, output: result });
    },
    [chat.addToolResult]
  );

  /**
   * Deny a pending tool call.
   */
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

  /**
   * Clear all chat history.
   */
  const clearHistory = useCallback(() => {
    chat.clearHistory();
  }, [chat.clearHistory]);

  return {
    // Messages
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    setMessages: chat.setMessages,
    clearHistory,

    // Tool confirmation
    pendingToolCalls,
    approve,
    deny,

    // Loading state
    isLoading: chat.status === "streaming" || chat.status === "submitted",

    // Connection
    sessionId: agent.id,
    connection: agent,

    // Errors
    error: chat.error
  };
}
