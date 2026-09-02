import type { UIMessage } from "ai";
import { DurableObject } from "cloudflare:workers";
import { ContextBlocks, type ContextProvider } from "../context";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Sessions,
  attachmentResponse,
  createCompactFunction,
  inlineReconstructor,
  pointerReconstructor,
  type AppendResult,
  type SessionMessage,
  type SessionStats
} from "../sessions";

class ConversationObject extends DurableObject {
  readonly sessions = new Sessions({
    attachments: () => ({
      maxAttachmentBytes: 8 * 1024 * 1024,
      reconstruct: inlineReconstructor
    })
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
}

declare const object: ConversationObject;
object.sessions satisfies DurableObjectCapability;

const soul: ContextProvider = {
  get: async () => "You are helpful."
};
const context = new ContextBlocks([
  { label: "soul", provider: soul },
  { label: "memory", maxTokens: 1_100, provider: soul }
]);
context.freezeSystemPrompt() satisfies Promise<string>;
context.refreshSystemPrompt() satisfies Promise<string>;
context.tools() satisfies Promise<Record<string, unknown>>;
context.getBlocks() satisfies Array<{
  label: string;
  content: string;
  tokens: number;
}>;

const session = object.sessions
  .session()
  .onCompaction(createCompactFunction({ summarize: async () => "summary" }))
  .compactAfter(100_000);
session.sessionId satisfies string;

const message: SessionMessage = {
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text: "hello" }]
};

session.appendMessage(message) satisfies Promise<AppendResult>;
declare const aiMessage: UIMessage;
session.appendMessage(aiMessage) satisfies Promise<AppendResult>;
session.updateMessage(message) satisfies Promise<SessionMessage | null>;
session.getMessage(message.id) satisfies Promise<SessionMessage | null>;
session.getHistory() satisfies Promise<SessionMessage[]>;
session.getRecentHistory(1024, 2) satisfies Promise<{
  messages: SessionMessage[];
  truncated: boolean;
  totalContentBytes: number;
}>;
session.stats() satisfies Promise<SessionStats>;
object.sessions.listSessions() satisfies Promise<
  Array<{ sessionId: string; messageCount: number; lastMessageAt: number }>
>;

async function consumeHistory(): Promise<void> {
  for await (const item of session.history({ reconstruct: "pointer" })) {
    item satisfies SessionMessage;
  }
  for await (const batch of session.historyBatches({
    batchSize: 25,
    maxBatchBytes: 1024
  })) {
    batch satisfies SessionMessage[];
  }
}
void consumeHistory;

object.sessions.attachments.put("document", {
  mediaType: "text/plain",
  filename: "document.txt"
}) satisfies Promise<{
  part: SessionMessage["parts"][number];
  attachment: {
    hash: string;
    path: string;
    mediaType: string;
    bytes: number;
    filename?: string;
  };
}>;
object.sessions.attachments.get("ab".repeat(32)) satisfies Promise<{
  hash: string;
  path: string;
  mediaType: string;
  bytes: number;
  filename?: string;
} | null>;
object.sessions.attachments.open("ab".repeat(32)) satisfies Promise<
  ReadableStream<Uint8Array>
>;
object.sessions.attachments.delete("ab".repeat(32)) satisfies Promise<boolean>;
attachmentResponse(
  object.sessions,
  "ab".repeat(32)
) satisfies Promise<Response>;

inlineReconstructor satisfies {
  part: (...args: never[]) => unknown;
};
pointerReconstructor satisfies {
  part: (...args: never[]) => unknown;
};

new Sessions({
  attachments: {
    // @ts-expect-error Sessions is a message store: there is no R2 tier.
    r2: {}
  }
});
