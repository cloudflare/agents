/**
 * Test agent for Think integration tests (WebSocket protocol).
 *
 * Extends Think and overrides onChatMessage to return a
 * simple streaming response.
 */

import { Think } from "../../think";
import type { ChatMessageOptions, StreamableResult } from "../../think";
import type { UIMessage } from "ai";

export class TestAssistantAgentAgent extends Think {
  async onChatMessage(
    _options?: ChatMessageOptions
  ): Promise<StreamableResult> {
    const chunks = [
      { type: "start", messageId: crypto.randomUUID() },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hello " },
      { type: "text-delta", id: "t1", delta: "from " },
      { type: "text-delta", id: "t1", delta: "assistant" },
      { type: "text-end", id: "t1" },
      { type: "finish", messageMetadata: {} }
    ];

    return {
      toUIMessageStream() {
        return (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })();
      }
    };
  }

  // ── Test introspection ────────────────────────────────────────
  override getMessages(): UIMessage[] {
    return this.messages;
  }
}
