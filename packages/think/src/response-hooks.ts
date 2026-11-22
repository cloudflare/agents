import type { ChatResponseResult } from "agents/chat";

/**
 * An `onChatResponse` call a turn owes. Held in the Outbox from just before
 * the assistant message is stored until the live hook ran, so a reset in
 * between fires it on the next start.
 */
export type OwedResponseHook = {
  requestId: string;
  messageId: string;
  continuation: boolean;
  status: ChatResponseResult["status"];
  error?: string;
};

/** Outbox sink that fires owed response hooks. */
export const RESPONSE_HOOK_SINK = "__cf_think_response_hook";

/** Storage prefix of owed hooks written by earlier releases. */
const LEGACY_PREFIX = "cf_think_pending_response_hook:";

/** The owed hook for one response. */
export function owedResponseHook(result: ChatResponseResult): OwedResponseHook {
  return {
    requestId: result.requestId,
    messageId: result.message.id,
    continuation: result.continuation,
    status: result.status,
    ...(result.error !== undefined && { error: result.error })
  };
}

/** Move owed hooks stored by earlier releases into the Outbox, held. */
export async function migrateLegacyResponseHooks(
  storage: DurableObjectStorage,
  hold: (hook: OwedResponseHook) => Promise<unknown>
): Promise<void> {
  const legacy = await storage.list<OwedResponseHook>({
    prefix: LEGACY_PREFIX
  });
  for (const [key, hook] of legacy) {
    await hold(hook);
    await storage.delete(key);
  }
}
