import { Agent } from "../../index";
import { Chat, Message } from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  FetchResult,
  FormattedContent,
  RawMessage,
  ThreadInfo
} from "chat";
import {
  ChatSdkStateAdapter,
  ChatSdkStateAgent,
  defaultKeyShard,
  defaultThreadShard
} from "../../chat-sdk";

export { ChatSdkStateAgent };

interface TestLockResult {
  first: boolean;
  second: boolean;
  extended: boolean;
  afterRelease: boolean;
}

interface TestQueueResult {
  first: string | null;
  second: string | null;
  third: string | null;
}

interface ChatFeatureResult {
  channelState: unknown;
  dedupeHandledCount: number;
  history: string[];
  threadState: unknown;
  transcriptAfterDelete: number;
  transcriptCount: number;
  transcriptList: string[];
}

export class TestChatSdkStateHostAgent extends Agent {
  async testDisconnectedGuard(): Promise<string> {
    const state = new ChatSdkStateAdapter();
    try {
      await state.isSubscribed("telegram:guard");
      return "no error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async testSubscriptions(threadId: string): Promise<boolean[]> {
    const state = await this.createState();

    const before = await state.isSubscribed(threadId);
    await state.subscribe(threadId);
    const afterSubscribe = await state.isSubscribed(threadId);
    await state.unsubscribe(threadId);
    const afterUnsubscribe = await state.isSubscribed(threadId);

    return [before, afterSubscribe, afterUnsubscribe];
  }

  async testLocks(threadId: string): Promise<TestLockResult> {
    const state = await this.createState();

    const first = await state.acquireLock(threadId, 30_000);
    const second = await state.acquireLock(threadId, 30_000);
    const extended = first ? await state.extendLock(first, 30_000) : false;
    if (first) {
      await state.releaseLock(first);
    }
    const afterRelease = await state.acquireLock(threadId, 30_000);
    if (afterRelease) {
      await state.releaseLock(afterRelease);
    }

    return {
      first: first !== null,
      second: second !== null,
      extended,
      afterRelease: afterRelease !== null
    };
  }

  async testExpiredLock(threadId: string): Promise<boolean> {
    const state = await this.createState();
    const expired = await state.acquireLock(threadId, -1);
    const reacquired = await state.acquireLock(threadId, 30_000);

    if (expired) {
      await state.releaseLock(expired);
    }
    if (reacquired) {
      await state.releaseLock(reacquired);
    }

    return reacquired !== null;
  }

  async testQueue(threadId: string): Promise<TestQueueResult> {
    const state = await this.createState();

    await state.enqueue(threadId, this.queueEntry(threadId, "a"), 2);
    await state.enqueue(threadId, this.queueEntry(threadId, "b"), 2);
    await state.enqueue(threadId, this.queueEntry(threadId, "c"), 2);

    return {
      first: (await state.dequeue(threadId))?.message.text ?? null,
      second: (await state.dequeue(threadId))?.message.text ?? null,
      third: (await state.dequeue(threadId))?.message.text ?? null
    };
  }

  async testExpiredQueue(threadId: string): Promise<boolean> {
    const state = await this.createState();
    await state.enqueue(threadId, this.queueEntry(threadId, "expired", -1), 10);
    return (await state.dequeue(threadId)) === null;
  }

  async testCache(key: string): Promise<unknown[]> {
    const state = await this.createState();

    await state.set(key, { value: 1 });
    const first = await state.get(key);
    const insertedExisting = await state.setIfNotExists(key, { value: 2 });
    await state.delete(key);
    const afterDelete = await state.get(key);
    const insertedMissing = await state.setIfNotExists(key, { value: 3 });
    const afterInsert = await state.get(key);
    await state.set(`${key}:expired`, "gone", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await state.get(`${key}:expired`);

    return [
      first,
      insertedExisting,
      afterDelete,
      insertedMissing,
      afterInsert,
      expired
    ];
  }

  async testList(key: string): Promise<unknown[][]> {
    const state = await this.createState();

    await state.appendToList(key, "a", { maxLength: 2 });
    await state.appendToList(key, "b", { maxLength: 2 });
    await state.appendToList(key, "c", { maxLength: 2 });
    const trimmed = await state.getList(key);

    const expiringKey = `${key}:expiring`;
    await state.appendToList(expiringKey, "soon", { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await state.getList(expiringKey);

    return [trimmed, expired];
  }

  async testListTtlRefresh(key: string): Promise<unknown[]> {
    const state = await this.createState();

    await state.appendToList(key, "first", { ttlMs: 60_000 });
    await state.appendToList(key, "second", { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    return state.getList(key);
  }

  async testShardRouting(): Promise<Record<string, string | undefined>> {
    return {
      thread: defaultKeyShard("thread-state:telegram:123:456"),
      channel: defaultKeyShard("channel-state:telegram:123"),
      history: defaultKeyShard("msg-history:telegram:123:456"),
      transcript: defaultKeyShard("transcripts:user:acme:user-123"),
      callback: defaultKeyShard("chat:callback:opaque"),
      fallbackThread: defaultThreadShard("telegram:123:456")
    };
  }

  async testChatFeaturePaths(): Promise<ChatFeatureResult> {
    const state = await this.createState();
    const adapter = this.createAdapter();
    const chat = new Chat({
      adapters: { test: adapter },
      userName: "bot",
      state,
      threadHistory: { maxMessages: 2, ttlMs: 60_000 },
      transcripts: { maxPerUser: 3, retention: "1h" },
      identity: () => "user-1"
    });
    await chat.initialize();

    const thread = chat.thread("test:C1:T1");
    await thread.setState({ mode: "alpha" });
    await thread.setState({ count: 2 });

    const channel = chat.channel("test:C1");
    await channel.setState({ topic: "support" });

    await thread.post("first");
    await thread.post("second");
    await thread.post("third");
    const history: string[] = [];
    for await (const message of thread.messages) {
      history.push(message.text);
    }

    await chat.transcripts.append(
      thread,
      { role: "assistant", text: "assistant reply" },
      { userKey: "user-1" }
    );
    await chat.transcripts.append(
      thread,
      { role: "system", text: "handoff marker" },
      { userKey: "user-1" }
    );
    const transcriptList = await chat.transcripts.list({ userKey: "user-1" });
    const transcriptCount = await chat.transcripts.count({ userKey: "user-1" });
    await chat.transcripts.delete({ userKey: "user-1" });
    const transcriptAfterDelete = await chat.transcripts.count({
      userKey: "user-1"
    });

    let dedupeHandledCount = 0;
    chat.onNewMessage(/hello/, async () => {
      dedupeHandledCount++;
    });
    const inbound = this.message("test:C1:T1", "hello once", {
      id: "inbound-1",
      isMe: false
    });
    await chat.processMessage(adapter, inbound.threadId, inbound);
    await chat.processMessage(adapter, inbound.threadId, inbound);

    const result = {
      channelState: await channel.state,
      dedupeHandledCount,
      history,
      threadState: await thread.state,
      transcriptAfterDelete,
      transcriptCount,
      transcriptList: transcriptList.map((entry) => entry.text)
    };
    await chat.shutdown();
    return result;
  }

  private async createState(): Promise<ChatSdkStateAdapter> {
    const state = new ChatSdkStateAdapter();
    await state.connect();
    return state;
  }

  private queueEntry(threadId: string, text: string, ttlMs = 60_000) {
    return {
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      message: this.message(threadId, text)
    };
  }

  private createAdapter(): Adapter {
    let nextMessageId = 0;
    const adapter: Adapter = {
      name: "test",
      userName: "bot",
      persistThreadHistory: true,
      addReaction: async () => {},
      channelIdFromThreadId: (threadId) =>
        threadId.split(":").slice(0, 2).join(":"),
      decodeThreadId: (threadId) => threadId,
      deleteMessage: async () => {},
      editMessage: async (threadId, messageId) => ({
        id: messageId,
        raw: {},
        threadId
      }),
      encodeThreadId: (threadId) => String(threadId),
      fetchMessages: async (): Promise<FetchResult> => ({ messages: [] }),
      fetchThread: async (threadId): Promise<ThreadInfo> => ({
        channelId: adapter.channelIdFromThreadId(threadId),
        id: threadId,
        metadata: {}
      }),
      handleWebhook: async () => new Response(null, { status: 204 }),
      initialize: async () => {},
      parseMessage: (raw) => raw as Message,
      postMessage: async (
        threadId: string,
        message: AdapterPostableMessage
      ): Promise<RawMessage> => ({
        id: `posted-${++nextMessageId}`,
        raw: message,
        threadId
      }),
      removeReaction: async () => {},
      renderFormatted: (content: FormattedContent) => JSON.stringify(content),
      startTyping: async () => {}
    };
    return adapter;
  }

  private message(
    threadId: string,
    text: string,
    options?: { id?: string; isMe?: boolean }
  ): Message {
    return new Message({
      id: options?.id ?? crypto.randomUUID(),
      threadId,
      text,
      formatted: {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "text", value: text }] }
        ]
      },
      raw: {},
      author: {
        userId: options?.isMe ? "bot" : "user",
        userName: options?.isMe ? "bot" : "user",
        fullName: options?.isMe ? "Test Bot" : "Test User",
        isBot: options?.isMe ?? false,
        isMe: options?.isMe ?? false
      },
      metadata: { dateSent: new Date(), edited: false },
      attachments: []
    });
  }
}
