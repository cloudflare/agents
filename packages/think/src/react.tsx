import type { UIMessage } from "ai";
import {
  useAgentChat as useAgentChatCore,
  type UseAgentChatOptions
} from "agents/chat/react";

export {
  getToolPartState,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolApproval,
  getAgentMessages
} from "agents/chat/react";

export type {
  AITool,
  ClientToolSchema,
  PrepareSendMessagesRequestOptions,
  PrepareSendMessagesRequestResult,
  OnToolCallCallback
} from "agents/chat/react";

export type ThinkChatOptions<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
> = Omit<UseAgentChatOptions<State, ChatMessage>, "syncMessagesToServer">;

export type UseThinkChatOptions<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
> = ThinkChatOptions<State, ChatMessage>;

const _thinkReactWarnings = new Set<string>();

function isProductionRuntime(): boolean {
  const maybeGlobal = globalThis as typeof globalThis & {
    process?: { env?: { NODE_ENV?: string } };
  };
  return maybeGlobal.process?.env?.NODE_ENV === "production";
}

/**
 * Think-facing chat hook.
 *
 * On Think, `setMessages` updates the local view only. It does not persist a
 * client-pushed transcript because Think's Session tree is server-authoritative.
 * Use `clearHistory()` for persisted clears.
 */
export function useAgentChat<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(options: ThinkChatOptions<State, ChatMessage>) {
  const maybeSyncMessagesToServer = (
    options as ThinkChatOptions<State, ChatMessage> & {
      syncMessagesToServer?: boolean;
    }
  ).syncMessagesToServer;

  if (
    !isProductionRuntime() &&
    maybeSyncMessagesToServer &&
    !_thinkReactWarnings.has("syncMessagesToServer")
  ) {
    _thinkReactWarnings.add("syncMessagesToServer");
    console.warn(
      "[@cloudflare/think] `syncMessagesToServer` has no effect: Think " +
        "ignores client-pushed transcripts. `setMessages` updates the local " +
        "view only. Use `clearHistory()` for persisted clears."
    );
  }

  return useAgentChatCore<State, ChatMessage>({
    ...options,
    syncMessagesToServer: false
  });
}
