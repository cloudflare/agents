import { Agent, routeAgentRequest } from "agents";
import {
  ChatSdkStateAdapter,
  defaultKeyShard,
  defaultThreadShard
} from "agents/chat-sdk";
import { Message } from "chat";
import appWorker, { ChatIngressAgent, ConversationAgent } from "../index";
import { shardTelegramStateKey } from "../provider/telegram";

export { ChatSdkStateAgent } from "agents/chat-sdk";

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

export class TestHostAgent extends Agent {
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
      dedupe: shardTelegramStateKey(
        "dedupe:telegram:123:999",
        defaultThreadShard
      ),
      callback: defaultKeyShard("chat:callback:opaque"),
      fallbackThread: defaultThreadShard("telegram:123:456")
    };
  }

  async testConversationFacet(): Promise<string> {
    await this.subAgent(
      ConversationAgent,
      `conversation:${crypto.randomUUID()}`
    );
    return "ok";
  }

  private async createState(): Promise<ChatSdkStateAdapter> {
    const state = new ChatSdkStateAdapter({
      parent: this
    });
    await state.connect();
    return state;
  }

  private queueEntry(threadId: string, text: string, ttlMs = 60_000) {
    return {
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      message: new Message({
        id: crypto.randomUUID(),
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
          userId: "user",
          userName: "user",
          fullName: "Test User",
          isBot: false,
          isMe: false
        },
        metadata: { dateSent: new Date(), edited: false },
        attachments: []
      })
    };
  }
}

export { ChatIngressAgent, ConversationAgent };

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      appWorker.fetch(request, env, {} as ExecutionContext)
    );
  }
} satisfies ExportedHandler<Cloudflare.Env>;
