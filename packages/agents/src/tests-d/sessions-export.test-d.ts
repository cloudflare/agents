import type { UIMessage } from "ai";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Sessions,
  attachmentResponse,
  createCompactFunction,
  inlineReconstructor,
  pointerReconstructor,
  type AppendResult,
  type ContextProvider,
  type SessionAttachmentStore,
  type SessionEvictionResult,
  type SessionMessage,
  type SessionStats
} from "../sessions";

class ConversationObject extends DurableObject {
  readonly attachmentStore: SessionAttachmentStore = {
    writeFileBytes: async () => {},
    readFileBytes: async () => null,
    readFileStream: async () => null,
    deleteFile: async () => false,
    stat: async () => null
  };

  readonly sessions = new Sessions({
    attachments: {
      store: () => this.attachmentStore,
      reconstruct: inlineReconstructor
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
}

declare const object: ConversationObject;
object.sessions satisfies DurableObjectCapability;

const soul: ContextProvider = {
  get: async () => "You are helpful."
};
const session = object.sessions
  .session()
  .withContext("soul", { provider: soul })
  .withContext("memory", { maxTokens: 1_100 })
  .withCachedPrompt()
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
session.updateMessage(message) satisfies Promise<SessionMessage>;
session.getMessage(message.id) satisfies Promise<SessionMessage | null>;
session.getHistory() satisfies Promise<SessionMessage[]>;
session.getRecentHistory(1024, 2) satisfies Promise<{
  messages: SessionMessage[];
  truncated: boolean;
  totalContentBytes: number;
}>;
session.stats() satisfies Promise<SessionStats>;
session.evictAgedMedia() satisfies Promise<SessionEvictionResult | null>;
session.freezeSystemPrompt() satisfies Promise<string>;
session.refreshSystemPrompt() satisfies Promise<string>;
session.getContextBlocks() satisfies Array<{
  label: string;
  content: string;
  tokens: number;
}>;
session.tools() satisfies Promise<Record<string, unknown>>;
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
    // @ts-expect-error attachment stores must provide streaming reads.
    store: {
      writeFileBytes: async () => {},
      readFileBytes: async () => null,
      deleteFile: async () => false,
      stat: async () => null
    }
  }
});
