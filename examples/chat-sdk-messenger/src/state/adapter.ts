import type { Lock, QueueEntry, StateAdapter } from "chat";
import type { SubAgentStub } from "agents";
import { ChatStateAgent } from "./agent";
import type { AgentStateAdapterOptions } from "./types";

const THREAD_STATE_PREFIX = "thread-state:";
const CHANNEL_STATE_PREFIX = "channel-state:";
const MESSAGE_HISTORY_PREFIX = "msg-history:";
const TELEGRAM_DEDUPE_PREFIX = "dedupe:telegram:";

function parseStoredJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`AgentChatStateAdapter expected JSON-encoded ${label}`, {
      cause: error
    });
  }
}

export function defaultThreadShard(threadId: string): string {
  return threadId.split(":").slice(0, 2).join(":") || "default";
}

export function defaultKeyShard(
  key: string,
  shardThread: (threadId: string) => string = defaultThreadShard
): string | undefined {
  for (const prefix of [
    THREAD_STATE_PREFIX,
    CHANNEL_STATE_PREFIX,
    MESSAGE_HISTORY_PREFIX
  ]) {
    if (key.startsWith(prefix)) {
      return shardThread(key.slice(prefix.length));
    }
  }

  if (key.startsWith(TELEGRAM_DEDUPE_PREFIX)) {
    const chatId = key.slice(TELEGRAM_DEDUPE_PREFIX.length).split(":")[0];
    return chatId ? shardThread(`telegram:${chatId}`) : undefined;
  }

  return undefined;
}

export class AgentChatStateAdapter implements StateAdapter {
  private readonly parent: AgentStateAdapterOptions["parent"];
  private readonly agentClass: typeof ChatStateAgent;
  private readonly defaultName: string;
  private readonly keyShard?: (key: string) => string | undefined;
  private readonly shardKey: (threadId: string) => string;
  private connected = false;

  constructor(options: AgentStateAdapterOptions) {
    this.parent = options.parent;
    this.agentClass = options.agent ?? ChatStateAgent;
    this.defaultName = options.name ?? "default";
    this.keyShard = options.keyShard;
    this.shardKey = options.shardKey ?? defaultThreadShard;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async subscribe(threadId: string): Promise<void> {
    await (await this.stateAgent(threadId)).subscribe(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await (await this.stateAgent(threadId)).unsubscribe(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return (await this.stateAgent(threadId)).isSubscribed(threadId);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return (await this.stateAgent(threadId)).acquireLock(threadId, ttlMs);
  }

  async releaseLock(lock: Lock): Promise<void> {
    await (
      await this.stateAgent(lock.threadId)
    ).releaseLock(lock.threadId, lock.token);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return (await this.stateAgent(lock.threadId)).extendLock(
      lock.threadId,
      lock.token,
      ttlMs
    );
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await (await this.stateAgent(threadId)).forceReleaseLock(threadId);
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number
  ): Promise<number> {
    return (await this.stateAgent(threadId)).enqueue(
      threadId,
      JSON.stringify(entry),
      maxSize
    );
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const raw = await (await this.stateAgent(threadId)).popQueue(threadId);
    return raw === null
      ? null
      : parseStoredJson<QueueEntry>(raw, `queue entry for ${threadId}`);
  }

  async queueDepth(threadId: string): Promise<number> {
    return (await this.stateAgent(threadId)).queueDepth(threadId);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    await (
      await this.stateAgentForKey(key)
    ).listAppend(
      key,
      JSON.stringify(value),
      options?.maxLength,
      options?.ttlMs
    );
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const raw = await (await this.stateAgentForKey(key)).listGet(key);
    return raw.map((value) =>
      parseStoredJson<T>(value, `list entry for ${key}`)
    );
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await (await this.stateAgentForKey(key)).cacheGet(key);
    return raw === null ? null : parseStoredJson<T>(raw, `cache key ${key}`);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await (
      await this.stateAgentForKey(key)
    ).cacheSet(key, JSON.stringify(value), ttlMs);
  }

  async setIfNotExists<T = unknown>(
    key: string,
    value: T,
    ttlMs?: number
  ): Promise<boolean> {
    return (await this.stateAgentForKey(key)).cacheSetIfNotExists(
      key,
      JSON.stringify(value),
      ttlMs
    );
  }

  async delete(key: string): Promise<void> {
    await (await this.stateAgentForKey(key)).cacheDelete(key);
  }

  private async stateAgent(
    threadId?: string
  ): Promise<SubAgentStub<ChatStateAgent>> {
    this.ensureConnected();
    const name = threadId ? this.shardKey(threadId) : this.defaultName;
    return this.parent.subAgent(this.agentClass, name);
  }

  private async stateAgentForKey(
    key: string
  ): Promise<SubAgentStub<ChatStateAgent>> {
    this.ensureConnected();
    const name =
      this.keyShard?.(key) ??
      defaultKeyShard(key, this.shardKey) ??
      this.defaultName;
    return this.parent.subAgent(this.agentClass, name);
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("AgentChatStateAdapter is not connected");
    }
  }
}
