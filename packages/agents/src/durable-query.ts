import type { Agent } from "./index";
import { MessageType } from "./ai-types";

/**
 * Pagination strategy for queries
 */
export type PaginationStrategy = "cursor" | "offset" | "stable-cursor";

/**
 * Query definition with optional pagination support
 */
export type QueryDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (
    args: TArgs,
    agent: Agent<unknown>
  ) => TResult[] | Promise<TResult[]>;
  dependencies?: string[];
  pagination?: {
    strategy: PaginationStrategy;
    keyField: string;
  };
};

/**
 * Mutation definition with invalidation support
 */
export type MutationDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (
    args: TArgs & { mutationId: string },
    agent: Agent<unknown>
  ) => TResult | Promise<TResult>;
  invalidates?: string[];
};

/**
 * Subscription manager for tracking query subscriptions
 */
export class QuerySubscriptionManager {
  private heartbeatInterval = 45000; // 45s
  private connectionGroups = new Map<string, Set<string>>();
  private readonly MAX_SUBSCRIPTIONS_PER_USER = 100;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(private agent: Agent<unknown>) {
    this.setupHeartbeat();
  }

  private setupHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      try {
        this.agent.broadcast(
          JSON.stringify({
            type: MessageType.CF_AGENT_HEARTBEAT,
            timestamp: Date.now()
          })
        );
      } catch (error) {
        console.error("Heartbeat broadcast failed:", error);
      }
    }, this.heartbeatInterval);
  }

  subscribe(
    connectionId: string,
    userId: string,
    queryName: string,
    args: unknown
  ) {
    const userSubs = this.agent.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_query_subscriptions
      WHERE user_id = ${userId}
    `[0];

    if (userSubs && userSubs.count >= this.MAX_SUBSCRIPTIONS_PER_USER) {
      throw new Error("Subscription limit exceeded");
    }

    if (!this.connectionGroups.has(userId)) {
      this.connectionGroups.set(userId, new Set());
    }
    this.connectionGroups.get(userId)!.add(connectionId);

    const dedupeKey = `${userId}:${queryName}:${JSON.stringify(args)}`;
    this.agent.sql`
      INSERT OR REPLACE INTO cf_agents_query_subscriptions
      (dedupe_key, user_id, query_name, query_args, connection_ids, subscribed_at)
      VALUES (${dedupeKey}, ${userId}, ${queryName}, ${JSON.stringify(args)},
              ${JSON.stringify([...this.connectionGroups.get(userId)!])}, ${Date.now()})
    `;
  }

  unsubscribe(
    connectionId: string,
    userId: string,
    queryName: string,
    args: unknown
  ) {
    const dedupeKey = `${userId}:${queryName}:${JSON.stringify(args)}`;
    this.connectionGroups.get(userId)?.delete(connectionId);

    if (this.connectionGroups.get(userId)?.size === 0) {
      this.agent.sql`
        DELETE FROM cf_agents_query_subscriptions
        WHERE dedupe_key = ${dedupeKey}
      `;
      this.connectionGroups.delete(userId);
    } else {
      this.agent.sql`
        UPDATE cf_agents_query_subscriptions
        SET connection_ids = ${JSON.stringify([...this.connectionGroups.get(userId)!])}
        WHERE dedupe_key = ${dedupeKey}
      `;
    }
  }

  getSubscriptions(userId: string) {
    return this.agent.sql<{
      query_name: string;
      query_args: string;
    }>`
      SELECT query_name, query_args
      FROM cf_agents_query_subscriptions
      WHERE user_id = ${userId}
    `;
  }

  getSubscribersForQuery(queryName: string) {
    return this.agent.sql<{
      user_id: string;
      connection_ids: string;
      query_args: string;
    }>`
      SELECT user_id, connection_ids, query_args
      FROM cf_agents_query_subscriptions
      WHERE query_name = ${queryName}
    `;
  }

  cleanupConnection(connectionId: string, userId: string) {
    this.connectionGroups.get(userId)?.delete(connectionId);

    const activeConnections = this.connectionGroups.get(userId);
    if (activeConnections && activeConnections.size > 0) {
      this.agent.sql`
        UPDATE cf_agents_query_subscriptions
        SET connection_ids = ${JSON.stringify([...activeConnections])}
        WHERE user_id = ${userId}
      `;
    } else {
      this.agent.sql`
        DELETE FROM cf_agents_query_subscriptions
        WHERE user_id = ${userId}
      `;
      this.connectionGroups.delete(userId);
    }
  }

  destroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
  }
}

/**
 * Type guards for query/mutation messages
 */
export function isQuerySubscribeMessage(msg: unknown): msg is {
  type: MessageType.CF_AGENT_QUERY_SUBSCRIBE;
  queryName: string;
  args: unknown;
  subscriptionId: string;
} {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === MessageType.CF_AGENT_QUERY_SUBSCRIBE &&
    "queryName" in msg &&
    "args" in msg &&
    "subscriptionId" in msg
  );
}

export function isQueryUnsubscribeMessage(msg: unknown): msg is {
  type: MessageType.CF_AGENT_QUERY_UNSUBSCRIBE;
  queryName: string;
  args: unknown;
} {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === MessageType.CF_AGENT_QUERY_UNSUBSCRIBE &&
    "queryName" in msg &&
    "args" in msg
  );
}

export function isMutationMessage(msg: unknown): msg is {
  type: MessageType.CF_AGENT_MUTATION;
  mutationName: string;
  args: unknown;
  mutationId: string;
} {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === MessageType.CF_AGENT_MUTATION &&
    "mutationName" in msg &&
    "args" in msg &&
    "mutationId" in msg
  );
}
