import type {
  Lock as ChatSdkLock,
  QueueEntry as ChatSdkQueueEntry,
  StateAdapter as ChatSdkStateAdapterInterface
} from "chat";
import {
  getCurrentAgent,
  type SubAgentClass,
  type SubAgentStub
} from "../index";
import { ChatSdkStateAgent } from "./agent";
import type { ChatSdkStateAdapterOptions } from "./types";

const THREAD_STATE_PREFIX = "thread-state:";
const CHANNEL_STATE_PREFIX = "channel-state:";
const MESSAGE_HISTORY_PREFIX = "msg-history:";
const TRANSCRIPTS_USER_PREFIX = "transcripts:user:";

function parseStoredJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`ChatSdkStateAdapter expected JSON-encoded ${label}`, {
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
    MESSAGE_HISTORY_PREFIX,
    TRANSCRIPTS_USER_PREFIX
  ]) {
    if (key.startsWith(prefix)) {
      return shardThread(key.slice(prefix.length));
    }
  }

  return undefined;
}

export class ChatSdkStateAdapter implements ChatSdkStateAdapterInterface {
  private readonly parent: NonNullable<ChatSdkStateAdapterOptions["parent"]>;
  private readonly agentClass: SubAgentClass<ChatSdkStateAgent>;
  private readonly defaultName: string;
  private readonly keyShard?: (key: string) => string | undefined;
  private readonly shardKey: (threadId: string) => string;
  private connected = false;

  constructor(options: ChatSdkStateAdapterOptions = {}) {
    const parent = options.parent ?? getCurrentAgent().agent;
    if (!parent) {
      throw new Error(
        "ChatSdkStateAdapter requires a parent Agent. Pass `parent` or create it inside an Agent context."
      );
    }

    this.parent = parent;
    this.agentClass = options.agent ?? ChatSdkStateAgent;
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

  async acquireLock(
    threadId: string,
    ttlMs: number
  ): Promise<ChatSdkLock | null> {
    return (await this.stateAgent(threadId)).acquireLock(threadId, ttlMs);
  }

  async releaseLock(lock: ChatSdkLock): Promise<void> {
    await (
      await this.stateAgent(lock.threadId)
    ).releaseLock(lock.threadId, lock.token);
  }

  async extendLock(lock: ChatSdkLock, ttlMs: number): Promise<boolean> {
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
    entry: ChatSdkQueueEntry,
    maxSize: number
  ): Promise<number> {
    return (await this.stateAgent(threadId)).enqueue(
      threadId,
      JSON.stringify(entry),
      maxSize
    );
  }

  async dequeue(threadId: string): Promise<ChatSdkQueueEntry | null> {
    const raw = await (await this.stateAgent(threadId)).popQueue(threadId);
    return raw === null
      ? null
      : parseStoredJson<ChatSdkQueueEntry>(raw, `queue entry for ${threadId}`);
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
  ): Promise<SubAgentStub<ChatSdkStateAgent>> {
    this.ensureConnected();
    const name = threadId ? this.shardKey(threadId) : this.defaultName;
    return this.parent.subAgent(this.agentClass, name);
  }

  private async stateAgentForKey(
    key: string
  ): Promise<SubAgentStub<ChatSdkStateAgent>> {
    this.ensureConnected();
    const name =
      this.keyShard?.(key) ??
      defaultKeyShard(key, this.shardKey) ??
      this.defaultName;
    return this.parent.subAgent(this.agentClass, name);
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("ChatSdkStateAdapter is not connected");
    }
  }
}
