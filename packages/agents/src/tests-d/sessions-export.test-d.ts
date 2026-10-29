import type { UIMessage } from "ai";
import { DurableObject } from "cloudflare:workers";
import {
  ContextBlocks,
  SEARCH_CONTEXT_TOOL,
  SET_CONTEXT_TOOL,
  type ContextBlock,
  type ContextProvider
} from "../context";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Sessions,
  createCompactFunction,
  type AppendResult,
  type SessionContextOptions,
  type SessionMessage,
  type SessionRowStat
} from "../sessions";

class ConversationObject extends DurableObject {
  readonly sessions = new Sessions({ reservedMetadataKeys: ["channel"] });
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

// Context declared on the session, the pre-capability shape.
const withBlocks = object.sessions
  .session("with-context")
  .withContext("soul", { provider: soul })
  .withContext("memory", { description: "Learned facts", maxTokens: 1_100 })
  .withContext("notes", { searchable: true, whenChanged: "wait" })
  .withCachedPrompt();
withBlocks.freezeSystemPrompt() satisfies Promise<string>;
withBlocks.refreshSystemPrompt() satisfies Promise<string>;
withBlocks.contextReminder() satisfies Promise<string | null>;
withBlocks.tools() satisfies Promise<Record<string, unknown>>;
withBlocks.addContext("late") satisfies Promise<ContextBlock>;
withBlocks.removeContext("late") satisfies boolean;
withBlocks.getContextBlock("memory") satisfies ContextBlock | null;
withBlocks.replaceContextBlock("memory", "x") satisfies Promise<ContextBlock>;
withBlocks.appendContextBlock("memory", "y") satisfies Promise<ContextBlock>;
withBlocks.context satisfies ContextBlocks;
({ searchable: true }) satisfies SessionContextOptions;
// @ts-expect-error A block label is the first argument, not an option.
({ label: "soul" }) satisfies SessionContextOptions;
SET_CONTEXT_TOOL satisfies "set_context";
SEARCH_CONTEXT_TOOL satisfies "search_context";

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
session.getHistoryRowStats() satisfies Promise<SessionRowStat[]>;
session.getRecentHistory(1024) satisfies Promise<{
  messages: SessionMessage[];
  truncated: boolean;
  totalContentBytes: number;
}>;
session.search("query") satisfies Promise<Array<{ id: string }>>;

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

new Sessions({
  // @ts-expect-error Sessions is a message store: there is no attachment tier.
  attachments: {}
});

new Sessions({
  // @ts-expect-error The FTS index is built by the first search, not by option.
  searchIndexing: true
});
