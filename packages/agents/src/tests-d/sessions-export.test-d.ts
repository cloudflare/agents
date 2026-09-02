import type { UIMessage } from "ai";
import { DurableObject } from "cloudflare:workers";
import { ContextBlocks, type ContextProvider } from "../context";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  MAX_INLINE_ROW_BYTES,
  Sessions,
  createCompactFunction,
  type AppendResult,
  type SessionMessage,
  type SessionStats
} from "../sessions";

class ConversationObject extends DurableObject {
  readonly sessions = new Sessions({ searchIndexing: true });
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
session.getRecentHistory(1024) satisfies Promise<{
  messages: SessionMessage[];
  truncated: boolean;
  totalContentBytes: number;
}>;
session.stats() satisfies Promise<SessionStats>;
object.sessions.listSessions() satisfies Promise<
  Array<{ sessionId: string; messageCount: number; lastMessageAt: number }>
>;

async function consumeHistory(): Promise<void> {
  for await (const item of session.history({ leafId: null })) {
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

MAX_INLINE_ROW_BYTES satisfies number;

new Sessions({
  // @ts-expect-error Sessions is a message store: there is no attachment tier.
  attachments: {}
});
