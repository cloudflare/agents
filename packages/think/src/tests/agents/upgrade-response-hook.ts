import type { LanguageModel, UIMessage } from "ai";
import { Think } from "../../think";
import type { ChatResponseResult } from "../../think";
import { createMockModel } from "./think-session";

/** The key think@0.24.0 kept an owed `onChatResponse` under. */
const RELEASED_PENDING_RESPONSE_HOOK_PREFIX = "cf_think_pending_response_hook:";
const RESPONSES_KEY = "test:responses";

/**
 * An agent upgraded over the owed response hook a release kept: a reply it
 * stored whose `onChatResponse` a reset cut off. It records every hook in
 * storage, so the record survives the restarts the test makes.
 */
export class ThinkUpgradeResponseHookAgent extends Think {
  override getModel(): LanguageModel {
    return createMockModel("upgrade response hook agent");
  }

  override onChatResponse(result: ChatResponseResult): void {
    const kv = this.ctx.storage.kv;
    const seen =
      kv.get<{ requestId: string; messageId: string; status: string }[]>(
        RESPONSES_KEY
      ) ?? [];
    seen.push({
      requestId: result.requestId,
      messageId: result.message.id,
      status: result.status
    });
    kv.put(RESPONSES_KEY, seen);
  }

  /**
   * Leave what think@0.24.0 left when a reset fell between storing a reply
   * and its hook: the question and the reply stored, and the hook owed under
   * its key, shaped as `_rememberPendingResponseHook` wrote it.
   */
  async leaveReleasedOwedHookForTest(): Promise<void> {
    await this.session.appendMessage({
      id: "u-owed",
      role: "user",
      parts: [{ type: "text", text: "hello" }]
    } as UIMessage);
    await this.session.appendMessage({
      id: "a-owed",
      role: "assistant",
      parts: [{ type: "text", text: "the reply" }]
    } as UIMessage);
    await this.ctx.storage.put(
      `${RELEASED_PENDING_RESPONSE_HOOK_PREFIX}r-owed`,
      {
        requestId: "r-owed",
        messageId: "a-owed",
        continuation: false,
        status: "completed"
      }
    );
  }

  /** End this isolate, as an eviction or a deploy does. */
  resetIsolateForTest(): void {
    this.ctx.abort("test reset");
  }

  async responsesForTest(): Promise<
    { requestId: string; messageId: string; status: string }[]
  > {
    return this.ctx.storage.kv.get(RESPONSES_KEY) ?? [];
  }

  async owedHookLeftForTest(): Promise<boolean> {
    return (
      (await this.ctx.storage.get(
        `${RELEASED_PENDING_RESPONSE_HOOK_PREFIX}r-owed`
      )) !== undefined
    );
  }
}
