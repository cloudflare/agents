# Durable Query/Mutation Sync System - Research & Implementation Plan

## Overview

This document outlines a comprehensive design for implementing bi-directional sync between Durable Objects (Agents) and client-side React applications using `useAgentChat`. The system enables clients to subscribe to database queries and execute mutations, with all connected clients seeing the same synchronized data in real-time.

## Problem Statement

Currently, the `agents` framework provides:

- State synchronization via `setState()` and `useAgent` with `onStateUpdate`
- WebSocket-based real-time communication
- Internal SQLite database accessible via `this.sql`
- Message broadcasting to all connected clients

However, there's no built-in pattern for:

- Clients subscribing to specific SQL queries from the Agent's database
- Automatic re-computation and broadcast when underlying data changes
- Type-safe query/mutation API similar to tRPC or React Query
- Managing query subscriptions across hibernation cycles

## Goals

1. **Client-Side Hooks**: Provide `useDurableQuery`, `useDurableMutation`, and `useDurableInfiniteQuery` React hooks built on **TanStack Query**
2. **Server-Side Query Registry**: Define queries and mutations inside the Agent/Durable Object
3. **Automatic Synchronization**: Broadcast query results when data changes
4. **Hibernation-Aware**: Handle WebSocket reconnection and query re-subscription after hibernation
5. **Type Safety**: Full TypeScript support for queries and mutations
6. **Efficient Broadcasting**: Only broadcast to clients subscribed to affected queries
7. **TanStack Query Integration**: Leverage battle-tested caching, deduplication, and state management
8. **Optimistic Updates**: Built-in support via TanStack Query's optimistic update system

## Current Architecture Analysis

### Existing Patterns in the Codebase

#### 1. State Synchronization (`setState`)

```typescript
// Agent side (index.ts:715-754)
private _setStateInternal(state: State, source: Connection | "server" = "server") {
  this._state = state;
  this.sql`INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (...)`;
  this.broadcast(JSON.stringify({ state, type: MessageType.CF_AGENT_STATE }), ...);
  this.onStateUpdate(state, source);
}

// Client side (react.tsx:339-341)
if (parsedMessage.type === MessageType.CF_AGENT_STATE) {
  options.onStateUpdate?.(parsedMessage.state as State, "server");
}
```

**Key Insight**: State changes are persisted to SQL, then broadcast to all clients, excluding the source client.

#### 2. RPC (Remote Procedure Calls)

```typescript
// Agent side (index.ts:544-604)
if (isRPCRequest(parsed)) {
  const { id, method, args } = parsed;
  const methodFn = this[method as keyof this];
  const result = await methodFn.apply(this, args);
  connection.send(
    JSON.stringify({ type: MessageType.RPC, id, result, success: true })
  );
}

// Client side (react.tsx:386-411)
const call = useCallback(
  (method: string, args: unknown[] = []) => {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      pendingCallsRef.current.set(id, { resolve, reject });
      agent.send(JSON.stringify({ type: MessageType.RPC, id, method, args }));
    });
  },
  [agent]
);
```

**Key Insight**: RPC uses request-response pattern with unique IDs. Supports streaming via `done` flag.

#### 3. WebSocket Broadcasting

```typescript
// From partyserver (inherited by Agent)
this.broadcast(message, excludeConnectionIds?: string[])
```

**Key Insight**: The Agent class extends `Server` from `partyserver`, which provides `broadcast()` functionality to send messages to all connected WebSocket clients.

#### 4. SQL Database Access

```typescript
// Agent side (index.ts:400-418)
sql<T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) {
  const query = strings.reduce((acc, str, i) =>
    acc + str + (i < values.length ? "?" : ""), ""
  );
  return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
}
```

**Key Insight**: SQL access is synchronous and returns arrays. All queries use parameterized statements.

#### 5. Hibernation Handling

```typescript
// Agent options (index.ts:383-386)
static options = {
  hibernate: true // default to hibernate
};
```

**Key Insight**: Agents hibernate by default. WebSocket connections can survive hibernation via the Hibernation API, but the Agent instance is recreated. We need to restore query subscriptions on reconnection.

## Proposed Architecture

### Message Types

Add new message types to `MessageType` enum:

```typescript
export enum MessageType {
  // ... existing types
  CF_AGENT_QUERY_SUBSCRIBE = "cf_agent_query_subscribe",
  CF_AGENT_QUERY_UNSUBSCRIBE = "cf_agent_query_unsubscribe",
  CF_AGENT_QUERY_DATA = "cf_agent_query_data",
  CF_AGENT_QUERY_ERROR = "cf_agent_query_error",
  CF_AGENT_MUTATION = "cf_agent_mutation",
  CF_AGENT_MUTATION_RESULT = "cf_agent_mutation_result",
  CF_AGENT_HEARTBEAT = "cf_agent_heartbeat",
  CF_AGENT_VERSION_MISMATCH = "cf_agent_version_mismatch"
}
```

### Core Components

#### 1. Query Registry (Server-Side)

Store query definitions in the Agent class:

```typescript
export type PaginationStrategy = "cursor" | "offset" | "stable-cursor";

export type QueryDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (args: TArgs, agent: Agent) => TResult[] | Promise<TResult[]>;
  dependencies?: string[]; // Table names that affect this query
  pagination?: {
    strategy: PaginationStrategy;
    keyField: string; // Field to use for cursor (e.g., "created_at", "id")
  };
};

export type MutationDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (args: TArgs & { mutationId: string }, agent: Agent) => TResult | Promise<TResult>;
  invalidates?: string[]; // Query names to invalidate after mutation
};

// In Agent class
protected queries = new Map<string, QueryDefinition>();
protected mutations = new Map<string, MutationDefinition>();

// Registration methods
protected registerQuery<TArgs, TResult>(
  name: string,
  execute: (args: TArgs) => TResult[],
  options?: { dependencies?: string[] }
) {
  this.queries.set(name, { name, execute, dependencies: options?.dependencies });
}

protected registerMutation<TArgs, TResult>(
  name: string,
  execute: (args: TArgs) => TResult,
  options?: { invalidates?: string[] }
) {
  this.mutations.set(name, { name, execute, invalidates: options?.invalidates });
}
```

#### 2. Subscription Manager (Server-Side)

Track which connections are subscribed to which queries with connection deduplication and heartbeat support:

```typescript
// Store in SQL for persistence across hibernation
// cf_agents_query_subscriptions table schema:
// - dedupe_key: TEXT (PRIMARY KEY) - userId:queryName:queryArgs hash for deduplication
// - user_id: TEXT
// - query_name: TEXT
// - query_args: TEXT (JSON serialized)
// - connection_ids: TEXT (JSON array of connection IDs)
// - subscribed_at: INTEGER

export class QuerySubscriptionManager {
  private heartbeatInterval = 45000; // 45s to beat corporate proxies
  private connectionGroups = new Map<string, Set<string>>();
  private readonly MAX_SUBSCRIPTIONS_PER_USER = 100;

  constructor(private agent: Agent) {
    this.setupHeartbeat();
  }

  private setupHeartbeat() {
    setInterval(() => {
      this.agent.broadcast(
        JSON.stringify({
          type: MessageType.CF_AGENT_HEARTBEAT,
          timestamp: Date.now()
        })
      );
    }, this.heartbeatInterval);
  }

  subscribe(
    connectionId: string,
    userId: string,
    queryName: string,
    args: unknown
  ) {
    // Check subscription limits
    const userSubs = this.agent.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_query_subscriptions 
      WHERE user_id = ${userId}
    `[0];

    if (userSubs.count >= this.MAX_SUBSCRIPTIONS_PER_USER) {
      throw new Error("Subscription limit exceeded");
    }

    // Group connections by userId to deduplicate subscriptions
    if (!this.connectionGroups.has(userId)) {
      this.connectionGroups.set(userId, new Set());
    }
    this.connectionGroups.get(userId)!.add(connectionId);

    // Only store one subscription per userId+query combination
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
      // Remove subscription if no connections left
      this.agent.sql`
        DELETE FROM cf_agents_query_subscriptions 
        WHERE dedupe_key = ${dedupeKey}
      `;
    } else {
      // Update connection list
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

    // Update all subscriptions to remove this connection
    const activeConnections = this.connectionGroups.get(userId);
    if (activeConnections && activeConnections.size > 0) {
      this.agent.sql`
        UPDATE cf_agents_query_subscriptions 
        SET connection_ids = ${JSON.stringify([...activeConnections])}
        WHERE user_id = ${userId}
      `;
    } else {
      // Remove all subscriptions for this user if no connections left
      this.agent.sql`
        DELETE FROM cf_agents_query_subscriptions 
        WHERE user_id = ${userId}
      `;
      this.connectionGroups.delete(userId);
    }
  }
}
```

#### 3. Query Execution & Broadcasting with Versioning

```typescript
// In Agent class
private globalVersion = 0;

private async executeQuery(queryName: string, args: unknown) {
  const queryDef = this.queries.get(queryName);
  if (!queryDef) {
    throw new Error(`Query ${queryName} not found`);
  }
  return await queryDef.execute(args, this);
}

private async broadcastQueryUpdate(queryName: string, version: number) {
  const subscribers = this.subscriptionManager.getSubscribersForQuery(queryName);

  for (const sub of subscribers) {
    const args = JSON.parse(sub.query_args);
    const data = await this.executeQuery(queryName, args);

    // Store update for hibernation recovery
    this.sql`
      INSERT INTO cf_agents_query_updates (query_name, query_args, version, created_at)
      VALUES (${queryName}, ${sub.query_args}, ${version}, ${Date.now()})
    `;

    // Send updated data to all user's connections
    const connectionIds = JSON.parse(sub.connection_ids);
    for (const connectionId of connectionIds) {
      const connection = this.connections.get(connectionId);
      if (connection) {
        try {
          connection.send(JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_DATA,
            queryName,
            args,
            data,
            version,
            timestamp: Date.now()
          }));
        } catch (error) {
          // Handle WebSocket errors gracefully
          console.warn(`Failed to send to connection ${connectionId}:`, error);
          this.connections.delete(connectionId);
        }
      }
    }
  }
}

// Trigger broadcasts after mutations with idempotency
private async executeMutation(mutationName: string, args: unknown & { mutationId: string }) {
  // Check for duplicate mutation (idempotency)
  const existing = this.sql<{ result: string }>`
    SELECT result FROM cf_agents_mutations
    WHERE mutation_id = ${args.mutationId}
  `[0];

  if (existing) {
    return JSON.parse(existing.result); // Return cached result
  }

  const mutationDef = this.mutations.get(mutationName);
  if (!mutationDef) {
    throw new Error(`Mutation ${mutationName} not found`);
  }

  const result = await mutationDef.execute(args, this);

  // Store result for idempotency
  this.sql`
    INSERT INTO cf_agents_mutations (mutation_id, mutation_name, args, result, created_at)
    VALUES (${args.mutationId}, ${mutationName}, ${JSON.stringify(args)}, ${JSON.stringify(result)}, ${Date.now()})
  `;

  // Increment global version for ordering
  this.globalVersion++;
  this.sql`
    INSERT OR REPLACE INTO cf_agents_metadata (key, value)
    VALUES ('global_version', ${this.globalVersion})
  `;

  // Invalidate and re-broadcast affected queries
  if (mutationDef.invalidates) {
    for (const queryName of mutationDef.invalidates) {
      await this.broadcastQueryUpdate(queryName, this.globalVersion);
    }
  }

  return result;
}
```

#### 4. Message Handlers

Add to Agent constructor's `onMessage` handler:

```typescript
// Handle query subscription
if (parsedMessage.type === MessageType.CF_AGENT_QUERY_SUBSCRIBE) {
  const { queryName, args, subscriptionId } = parsedMessage;

  // Add subscription
  this.subscriptionManager.subscribe(connection.id, queryName, args);

  // Immediately send current data
  const data = await this.executeQuery(queryName, args);
  connection.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_QUERY_DATA,
      queryName,
      args,
      subscriptionId,
      data,
      timestamp: Date.now()
    })
  );
}

// Handle query unsubscription
if (parsedMessage.type === MessageType.CF_AGENT_QUERY_UNSUBSCRIBE) {
  const { queryName, args } = parsedMessage;
  this.subscriptionManager.unsubscribe(connection.id, queryName, args);
}

// Handle mutation
if (parsedMessage.type === MessageType.CF_AGENT_MUTATION) {
  const { mutationName, args, mutationId } = parsedMessage;

  try {
    const result = await this.executeMutation(mutationName, args);
    connection.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_MUTATION_RESULT,
        mutationId,
        success: true,
        result,
        timestamp: Date.now()
      })
    );
  } catch (error) {
    connection.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_MUTATION_RESULT,
        mutationId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}
```

Add to `onConnect` handler:

```typescript
// On reconnection (e.g., after hibernation), restore subscriptions
const subscriptions = this.subscriptionManager.getSubscriptions(connection.id);
for (const sub of subscriptions) {
  const args = JSON.parse(sub.query_args);
  const data = await this.executeQuery(sub.query_name, args);
  connection.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_QUERY_DATA,
      queryName: sub.query_name,
      args,
      data,
      timestamp: Date.now()
    })
  );
}
```

Add to `onClose` handler:

```typescript
// Clean up subscriptions when connection closes permanently
this.subscriptionManager.cleanupConnection(connection.id);
```

#### 5. Client-Side Hooks (Built on TanStack Query)

> **📘 Full Implementation**: See [durable-query-mutation-sync-tanstack.md](./durable-query-mutation-sync-tanstack.md) for complete TanStack Query integration details.

The client hooks are built on **TanStack Query (React Query)** to leverage its proven caching, deduplication, and state management capabilities while adding real-time WebSocket synchronization.

**Key Benefits:**

- Battle-tested caching and request deduplication
- Automatic background refetching
- Built-in optimistic updates support
- Rich DevTools for debugging
- Framework-agnostic core (can extend to Vue, Solid, etc.)

**Dependencies:**

```json
{
  "dependencies": {
    "@tanstack/react-query": "^5.0.0",
    "agents": "latest"
  }
}
```

**Setup:**

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000,
      refetchOnWindowFocus: true,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
    </QueryClientProvider>
  );
}
```

##### `useDurableQuery` (Simplified Overview)

```typescript
import { useQuery, useQueryClient } from "@tanstack/react-query";

export function useDurableQuery<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  queryName: string,
  args: TArgs,
  options?: Omit<UseQueryOptions<TResult[], Error>, "queryKey" | "queryFn">
) {
  const queryClient = useQueryClient();

  // Create stable query key for TanStack Query
  const queryKey = ["durable", agent.agent, agent.name, queryName, args];

  // Use TanStack Query with WebSocket-based query function
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      // Subscribe and wait for initial data via WebSocket
      return fetchViaSubscription(agent, queryName, args);
    },
    ...options // All TanStack Query options available
  });

  // Set up real-time WebSocket listener to update cache
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data);
      if (message.type === MessageType.CF_AGENT_QUERY_DATA) {
        // Update TanStack Query cache when real-time updates arrive
        queryClient.setQueryData(queryKey, message.data);
      }
    };

    agent.addEventListener("message", handleMessage);
    return () => {
      agent.removeEventListener("message", handleMessage);
      // Unsubscribe from Agent
    };
  }, [agent, queryKey]);

  return query; // Returns TanStack Query result with all features
}
```

**Full implementation available in [durable-query-mutation-sync-tanstack.md](./durable-query-mutation-sync-tanstack.md)**

**Usage:**

```typescript
const { data, isLoading, error, refetch, isFetching } = useDurableQuery(
  agent,
  "getTodos",
  { completed: false },
  {
    staleTime: 5000,
    refetchOnWindowFocus: true
    // All TanStack Query options work!
  }
);
```

##### `useDurableMutation` (Simplified Overview)

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useDurableMutation<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  mutationName: string,
  options?: Omit<UseMutationOptions<TResult, Error, TArgs>, "mutationFn">
) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (args: TArgs) => {
      // Send mutation via WebSocket and wait for result
      return executeMutationViaWebSocket(agent, mutationName, args);
    },
    ...options,
    onSuccess: (data, variables, context) => {
      // Server broadcasts query updates automatically
      // TanStack Query handles cache updates via WebSocket listeners
      options?.onSuccess?.(data, variables, context);
    }
  });

  return mutation;
}
```

**Full implementation available in [durable-query-mutation-sync-tanstack.md](./durable-query-mutation-sync-tanstack.md)**

**Usage:**

```typescript
const { mutate, mutateAsync, isPending, error } = useDurableMutation(
  agent,
  'addTodo',
  {
    onSuccess: (result) => {
      console.log('Todo added:', result);
      // No manual invalidation needed - server broadcasts updates
    },
    // Optimistic updates supported
    onMutate: async (newTodo) => {
      await queryClient.cancelQueries({ queryKey: ['durable', ...] });
      queryClient.setQueryData(['durable', ...], (old) => [...old, newTodo]);
      return { previousValue };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      queryClient.setQueryData(['durable', ...], context.previousValue);
    }
  }
);

// Use mutation
mutate({ text: 'New todo' });
```

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)

1. **Add Message Types**
   - Update `MessageType` enum in `ai-types.ts`
   - Add TypeScript types for query/mutation messages

2. **Create Subscription Manager**
   - Add SQL table for subscriptions in Agent constructor
   - Implement `QuerySubscriptionManager` class
   - Add cleanup logic for disconnected clients

3. **Basic Query Registry**
   - Add `registerQuery` and `registerMutation` methods to Agent
   - Implement query execution logic
   - Add message handlers for subscribe/unsubscribe

### Phase 2: Broadcasting & Invalidation (Week 2)

1. **Query Broadcasting**
   - Implement `broadcastQueryUpdate` method
   - Add mutation execution with invalidation
   - Handle connection restoration after hibernation

2. **Optimization**
   - Implement query result caching
   - Add debouncing for rapid mutations
   - Optimize subscription lookups

### Phase 3: Client Hooks (Week 2)

1. **Implement `useDurableQuery`**
   - Basic subscription and data fetching
   - Error handling and loading states
   - Refetch functionality

2. **Implement `useDurableMutation`**
   - Mutation execution
   - Success/error callbacks
   - Loading state management

### Phase 4: Testing & Documentation (Week 3)

1. **Unit Tests**
   - Test subscription manager
   - Test query/mutation execution
   - Test hibernation scenarios

2. **Integration Tests**
   - Test client-server communication
   - Test multiple clients syncing
   - Test reconnection after hibernation

3. **Documentation**
   - API documentation
   - Usage examples
   - Migration guide

4. **Example Application**
   - Build a todo app demonstrating the pattern
   - Show optimistic updates
   - Demonstrate real-time sync

## Usage Examples

### Server-Side (Agent)

```typescript
import { Agent } from "agents";

interface Todo {
  id: string;
  text: string;
  completed: boolean;
  created_at: number;
}

export class TodoAgent extends Agent<Env, {}> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Create todos table
    this.sql`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;

    // Register queries
    this.registerQuery<{ completed?: boolean }, Todo>(
      "getTodos",
      (args) => {
        if (args.completed !== undefined) {
          return this.sql<Todo>`
            SELECT * FROM todos 
            WHERE completed = ${args.completed ? 1 : 0}
            ORDER BY created_at DESC
          `;
        }
        return this.sql<Todo>`
          SELECT * FROM todos ORDER BY created_at DESC
        `;
      },
      { dependencies: ["todos"] }
    );

    this.registerQuery<{ id: string }, Todo>(
      "getTodo",
      (args) => {
        return this.sql<Todo>`
          SELECT * FROM todos WHERE id = ${args.id}
        `;
      },
      { dependencies: ["todos"] }
    );

    // Register mutations
    this.registerMutation<{ text: string }, { id: string }>(
      "addTodo",
      (args) => {
        const id = nanoid();
        this.sql`
          INSERT INTO todos (id, text, completed)
          VALUES (${id}, ${args.text}, 0)
        `;
        return { id };
      },
      { invalidates: ["getTodos"] }
    );

    this.registerMutation<{ id: string; completed: boolean }, void>(
      "toggleTodo",
      (args) => {
        this.sql`
          UPDATE todos 
          SET completed = ${args.completed ? 1 : 0}
          WHERE id = ${args.id}
        `;
      },
      { invalidates: ["getTodos", "getTodo"] }
    );

    this.registerMutation<{ id: string }, void>(
      "deleteTodo",
      (args) => {
        this.sql`DELETE FROM todos WHERE id = ${args.id}`;
      },
      { invalidates: ["getTodos"] }
    );
  }
}
```

### Client-Side (React)

```typescript
import { useAgent } from 'agents/react';
import { useDurableQuery, useDurableMutation } from 'agents/react';

function TodoApp() {
  const agent = useAgent({ agent: 'TodoAgent', name: 'default' });

  // Query all todos
  const { data: todos, isLoading } = useDurableQuery(
    agent,
    'getTodos',
    { completed: false }
  );

  // Add todo mutation
  const { mutate: addTodo } = useDurableMutation(
    agent,
    'addTodo',
    {
      onSuccess: () => console.log('Todo added!'),
    }
  );

  // Toggle todo mutation
  const { mutate: toggleTodo } = useDurableMutation(
    agent,
    'toggleTodo'
  );

  // Delete todo mutation
  const { mutate: deleteTodo } = useDurableMutation(
    agent,
    'deleteTodo'
  );

  const handleAddTodo = async (text: string) => {
    await addTodo({ text });
  };

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <h1>Todos</h1>
      <input
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleAddTodo(e.currentTarget.value);
            e.currentTarget.value = '';
          }
        }}
        placeholder="Add a todo..."
      />
      <ul>
        {todos?.map((todo) => (
          <li key={todo.id}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo({
                id: todo.id,
                completed: !todo.completed
              })}
            />
            <span>{todo.text}</span>
            <button onClick={() => deleteTodo({ id: todo.id })}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## Key Considerations

### Pagination Support

**Challenge**: Large result sets need to be paginated for performance and usability.

**Solution**: Support both cursor-based and offset-based pagination patterns.

#### Cursor-Based Pagination (Recommended)

Cursor-based pagination is more efficient and provides stable results when data changes:

```typescript
// Server-side query with cursor support
this.registerQuery<
  { cursor?: string; limit?: number; completed?: boolean },
  Todo
>(
  "getTodos",
  (args) => {
    const limit = args.limit || 20;
    const cursorCondition = args.cursor
      ? this.sql`AND created_at < ${args.cursor}`
      : this.sql``;

    return this.sql<Todo>`
      SELECT * FROM todos 
      WHERE ${args.completed !== undefined ? this.sql`completed = ${args.completed ? 1 : 0}` : this.sql`1=1`}
      ${cursorCondition}
      ORDER BY created_at DESC 
      LIMIT ${limit + 1}
    `;
  },
  { dependencies: ["todos"] }
);

// Client-side hook with infinite scroll
const {
  data, // All pages flattened into single array
  hasNextPage, // Boolean indicating more data available
  fetchNextPage, // Function to load next page
  isFetchingNextPage,
  refetch // Re-fetch all pages
} = useDurableInfiniteQuery(
  agent,
  "getTodos",
  { limit: 20, completed: false },
  {
    getNextPageParam: (lastPage) => {
      // Return undefined when no more pages
      if (lastPage.length <= 20) return undefined;
      // Use last item's timestamp as cursor
      return lastPage[lastPage.length - 1].created_at;
    }
  }
);
```

#### Offset-Based Pagination

For traditional page-based navigation:

```typescript
// Server-side query with offset and total count
this.registerQuery<
  { page: number; pageSize: number },
  { todos: Todo[]; total: number; pages: number }
>(
  "getTodosPaginated",
  (args) => {
    const offset = args.page * args.pageSize;
    const todos = this.sql<Todo>`
      SELECT * FROM todos 
      ORDER BY created_at DESC 
      LIMIT ${args.pageSize} OFFSET ${offset}
    `;
    const [{ count }] = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM todos
    `;

    return [
      {
        todos,
        total: count,
        pages: Math.ceil(count / args.pageSize)
      }
    ];
  },
  { dependencies: ["todos"] }
);

// Client-side with manual page control
const [page, setPage] = useState(0);
const { data, isLoading } = useDurableQuery(agent, "getTodosPaginated", {
  page,
  pageSize: 20
});

// Access: data[0].todos, data[0].total, data[0].pages
```

#### Infinite Query Hook Implementation

```typescript
export function useDurableInfiniteQuery<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  queryName: string,
  baseArgs: TArgs,
  options: {
    getNextPageParam: (lastPage: TResult[]) => string | undefined;
    enabled?: boolean;
  }
): {
  data: TResult[];
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
  refetch: () => void;
} {
  const [pages, setPages] = useState<TResult[][]>([]);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);

  const currentCursor = cursors[cursors.length - 1];
  const queryArgs = { ...baseArgs, cursor: currentCursor };

  // Subscribe to query with current cursor
  const { data: currentPageData, isLoading } = useDurableQuery(
    agent,
    queryName,
    queryArgs,
    { enabled: options.enabled }
  );

  useEffect(() => {
    if (currentPageData && !isLoading) {
      setPages((prev) => {
        const newPages = [...prev];
        newPages[cursors.length - 1] = currentPageData;
        return newPages;
      });
      setIsFetchingNextPage(false);
    }
  }, [currentPageData, isLoading]);

  const hasNextPage = currentPageData
    ? options.getNextPageParam(currentPageData) !== undefined
    : false;

  const fetchNextPage = useCallback(() => {
    if (!currentPageData || !hasNextPage) return;

    const nextCursor = options.getNextPageParam(currentPageData);
    setCursors((prev) => [...prev, nextCursor]);
    setIsFetchingNextPage(true);
  }, [currentPageData, hasNextPage, options]);

  const refetch = useCallback(() => {
    setCursors([undefined]);
    setPages([]);
  }, []);

  const flatData = pages.flat();

  return {
    data: flatData,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch
  };
}
```

#### Pagination with Real-time Updates

When new data arrives via mutations, pagination behavior:

**Cursor-based (Recommended)**:

- New items appear naturally at the beginning of the list
- Existing pages remain stable (no shifting)
- Users can continue scrolling without disruption

**Offset-based**:

- May cause items to shift between pages
- Consider re-fetching current page after mutations
- Show "new items available" notification instead of auto-updating

```typescript
// Mutation with smart invalidation
this.registerMutation<{ text: string }, { id: string }>(
  "addTodo",
  (args) => {
    const id = nanoid();
    this.sql`
      INSERT INTO todos (id, text, created_at)
      VALUES (${id}, ${args.text}, ${Date.now()})
    `;
    return { id };
  },
  {
    // Invalidates all getTodos queries regardless of pagination params
    invalidates: ["getTodos", "getTodosPaginated"]
  }
);

// Client can choose to handle updates differently for paginated views
const { mutate: addTodo } = useDurableMutation(agent, "addTodo", {
  onSuccess: (result) => {
    // For infinite scroll: prepend optimistically or refetch first page
    // For pagination: show "new items" banner, don't auto-update
  }
});
```

#### Subscription Persistence for Paginated Queries

Each page subscription is stored separately:

```sql
-- Subscriptions table tracks cursor/page for each subscription
CREATE TABLE cf_agents_query_subscriptions (
  connection_id TEXT,
  query_name TEXT,
  query_args TEXT,  -- JSON: { "cursor": "1234567890", "limit": 20 }
  subscribed_at INTEGER
);
```

When a client has multiple pages loaded (e.g., scrolled down), each page maintains its own subscription. On reconnection after hibernation, all subscriptions are restored.

### Hibernation Strategy with Missed Update Recovery

**Challenge**: When a Durable Object hibernates, the Agent instance is destroyed but WebSocket connections persist. On wake-up, we need to restore query subscriptions and replay missed updates.

**Solution**:

1. Store all subscriptions in the SQL database (`cf_agents_query_subscriptions` table)
2. Store query updates with versions in `cf_agents_query_updates` table
3. On `onConnect`, check if this is a reconnection and replay missed updates
4. Clean up subscriptions only when the connection is permanently closed

````typescript
export class Agent extends Server {
  private lastWakeTime = Date.now();

  async onConnect(connection: Connection) {
    const connectionId = connection.id;
    const userId = await this.extractUserId(connection);

    if (!userId) {
      connection.close(1008, "Authentication required");
      return;
    }

    // Check for existing subscriptions (reconnection after hibernation)
    const existingSubscriptions = this.subscriptionManager.getSubscriptions(userId);

    if (existingSubscriptions.length > 0) {
      // This is a reconnection - replay missed updates
      for (const sub of existingSubscriptions) {
        const queryName = sub.query_name;
        const args = JSON.parse(sub.query_args);

        // Check for missed updates since last wake
        const missedUpdates = this.sql<{ version: number; data: string }>`
          SELECT version, data FROM cf_agents_query_updates
          WHERE query_name = ${queryName}
          AND query_args = ${sub.query_args}
          AND created_at > ${this.lastWakeTime}
          ORDER BY version ASC
        `;

        if (missedUpdates.length > 0) {
          // Send the latest update
          const latestUpdate = missedUpdates[missedUpdates.length - 1];
          connection.send(JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_DATA,
            queryName,
            args,
            data: JSON.parse(latestUpdate.data),
            version: latestUpdate.version,
            timestamp: Date.now()
          }));
        } else {
          // No missed updates, send current data
          const currentData = await this.executeQuery(queryName, args);
          connection.send(JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_DATA,
            queryName,
            args,
            data: currentData,
            version: this.globalVersion,
            timestamp: Date.now()
          }));
        }
      }

      // Update connection mapping
      this.subscriptionManager.addConnectionToUser(connectionId, userId);
    }

    this.lastWakeTime = Date.now();
  }

  async onClose(connection: Connection) {
    const userId = await this.extractUserId(connection);
    if (userId) {
      this.subscriptionManager.cleanupConnection(connection.id, userId);
    }
  }
}

### Security & Resource Management

**Critical security considerations and resource limits:**

```typescript
export class Agent extends Server {
  private readonly MAX_MESSAGE_SIZE = 64 * 1024; // 64KB
  private readonly MAX_SUBSCRIPTIONS_PER_USER = 100;
  private readonly MAX_BROADCAST_QUEUE = 100;
  private readonly HEARTBEAT_INTERVAL = 45000; // 45s to beat corporate proxies

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    if (typeof message !== "string") {
      connection.close(1003, "Binary messages not supported");
      return;
    }

    // Message size limit
    if (message.length > this.MAX_MESSAGE_SIZE) {
      connection.close(1009, "Message too large");
      return;
    }

    try {
      const parsed = JSON.parse(message);

      // Version compatibility check
      if (parsed.version && parsed.version !== CURRENT_PROTOCOL_VERSION) {
        connection.send(JSON.stringify({
          type: MessageType.CF_AGENT_VERSION_MISMATCH,
          supportedVersion: CURRENT_PROTOCOL_VERSION,
          clientVersion: parsed.version
        }));
        return;
      }

      // Extract and verify user authorization
      const userId = await this.extractUserId(connection);
      if (!userId) {
        connection.close(1008, "Authentication required");
        return;
      }

      // Rate limiting per user
      if (await this.isRateLimited(userId)) {
        connection.send(JSON.stringify({
          type: MessageType.CF_AGENT_QUERY_ERROR,
          error: "Rate limit exceeded"
        }));
        return;
      }

      // Subscription limits
      if (parsed.type === MessageType.CF_AGENT_QUERY_SUBSCRIBE) {
        const userSubs = this.sql<{ count: number }>`
          SELECT COUNT(*) as count FROM cf_agents_query_subscriptions
          WHERE user_id = ${userId}
        `[0];

        if (userSubs.count >= this.MAX_SUBSCRIPTIONS_PER_USER) {
          connection.send(JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_ERROR,
            error: "Subscription limit exceeded"
          }));
          return;
        }
      }

      // Cross-tenant isolation check
      if (parsed.type === MessageType.CF_AGENT_QUERY_SUBSCRIBE ||
          parsed.type === MessageType.CF_AGENT_MUTATION) {
        if (!await this.verifyUserAccess(userId, parsed)) {
          connection.close(1008, "Unauthorized access");
          return;
        }
      }

      // Process message with user context
      await this.handleMessage(connection, parsed, userId);

    } catch (error) {
      console.warn("Invalid message:", error);
      connection.close(1002, "Invalid JSON");
    }
  }

  // Safe broadcast with resource limits
  broadcast(message: string, excludeConnectionIds?: string[]) {
    const connections = [...this.connections.values()]
      .filter(conn => !excludeConnectionIds?.includes(conn.id))
      .slice(0, this.MAX_BROADCAST_QUEUE); // Limit broadcast size

    let successCount = 0;
    let errorCount = 0;

    connections.forEach(conn => {
      try {
        conn.send(message);
        successCount++;
      } catch (error) {
        errorCount++;
        console.warn(`Failed to send to connection ${conn.id}:`, error);
        this.connections.delete(conn.id);
      }
    });

    // Log metrics for monitoring
    if (errorCount > 0) {
      console.log(`Broadcast: ${successCount} sent, ${errorCount} failed`);
    }
  }

  private async extractUserId(connection: Connection): Promise<string | null> {
    // Extract from JWT in headers or URL params
    const token = connection.request?.headers?.authorization?.replace('Bearer ', '') ||
                  connection.request?.url?.searchParams?.get('token');

    if (!token) return null;

    try {
      const payload = await this.verifyJWT(token);
      return payload.sub || payload.userId;
    } catch (error) {
      return null;
    }
  }

  private async verifyUserAccess(userId: string, message: any): Promise<boolean> {
    // Implement tenant isolation logic
    // Ensure user can only access their own data

    if (message.type === MessageType.CF_AGENT_QUERY_SUBSCRIBE) {
      // Check if user can subscribe to this query with these args
      return await this.canUserAccessQuery(userId, message.queryName, message.args);
    }

    if (message.type === MessageType.CF_AGENT_MUTATION) {
      // Check if user can execute this mutation
      return await this.canUserExecuteMutation(userId, message.mutationName, message.args);
    }

    return false;
  }

  private async isRateLimited(userId: string): Promise<boolean> {
    const window = 60 * 1000; // 1 minute
    const maxRequests = 100; // 100 requests per minute

    const key = `rate_limit:${userId}`;
    const count = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_rate_limits
      WHERE user_id = ${userId} AND created_at > ${Date.now() - window}
    `[0]?.count || 0;

    if (count >= maxRequests) {
      return true;
    }

    // Record this request
    this.sql`
      INSERT INTO cf_agents_rate_limits (user_id, created_at)
      VALUES (${userId}, ${Date.now()})
    `;

    // Cleanup old entries
    this.sql`
      DELETE FROM cf_agents_rate_limits
      WHERE created_at < ${Date.now() - window}
    `;

    return false;
  }
}
````

### Database Schema for Edge Case Handling

**Required tables for robust operation:**

```sql
-- Query subscriptions with deduplication
CREATE TABLE cf_agents_query_subscriptions (
  dedupe_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  query_name TEXT NOT NULL,
  query_args TEXT NOT NULL,
  connection_ids TEXT NOT NULL, -- JSON array
  subscribed_at INTEGER NOT NULL
);

-- Mutation idempotency tracking
CREATE TABLE cf_agents_mutations (
  mutation_id TEXT PRIMARY KEY,
  mutation_name TEXT NOT NULL,
  args TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Query update history for hibernation recovery
CREATE TABLE cf_agents_query_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_name TEXT NOT NULL,
  query_args TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Global metadata
CREATE TABLE cf_agents_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Rate limiting
CREATE TABLE cf_agents_rate_limits (
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX idx_subscriptions_user ON cf_agents_query_subscriptions(user_id);
CREATE INDEX idx_subscriptions_query ON cf_agents_query_subscriptions(query_name);
CREATE INDEX idx_updates_query ON cf_agents_query_updates(query_name, query_args);
CREATE INDEX idx_updates_version ON cf_agents_query_updates(version);
CREATE INDEX idx_rate_limits_user ON cf_agents_rate_limits(user_id, created_at);
```

### Critical Edge Cases & Mitigations

**1. Connection Management:**

- ✅ **Multiple tabs**: Deduplicate subscriptions by userId+query
- ✅ **Corporate proxies**: 45s heartbeat interval
- ✅ **WebSocket errors**: Graceful error handling with connection cleanup
- ✅ **Back-pressure**: Limit broadcast queue to prevent memory exhaustion

**2. Data Consistency:**

- ✅ **Mutation idempotency**: Server-side mutation ID tracking
- ✅ **Out-of-order updates**: Version numbering for proper ordering
- ✅ **Hibernation gaps**: Store and replay missed updates
- ✅ **Pagination drift**: Strategy selection (cursor vs offset)

**3. Security & Resource Limits:**

- ✅ **Cross-tenant access**: User isolation with JWT verification
- ✅ **Message size limits**: 64KB max message size
- ✅ **Subscription limits**: 100 subscriptions per user
- ✅ **Rate limiting**: 100 requests per minute per user
- ✅ **Version compatibility**: Protocol version checking

**4. React Integration:**

- ✅ **StrictMode**: Prevent duplicate subscriptions
- ✅ **SSR hydration**: Proper initialization order
- ✅ **Background tabs**: Resource cleanup and optimization
- ✅ **Optimistic updates**: TanStack Query integration

**5. Performance & Monitoring:**

- ✅ **Broadcast metrics**: Success/failure tracking
- ✅ **Query performance**: Proper indexing
- ✅ **Memory management**: Subscription cleanup
- ✅ **Debug logging**: Comprehensive error reporting

### Storage Backend Selection with Drizzle ORM

**Challenge**: Durable Object SQLite storage is limited to 10GB per instance. For larger datasets or multi-tenant scenarios, we need to support external databases like D1.

**Solution**: Use **Drizzle ORM** to abstract the database layer, supporting both:

- **Local SQLite** (default): Isolated per Durable Object, no filtering needed
- **D1 or other databases**: Shared database with automatic user filtering

#### Drizzle Schema Definition

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Define schema with optional userId for multi-tenancy
export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  userId: text("user_id"), // Only used with D1/shared databases
  text: text("text").notNull(),
  completed: integer("completed", { mode: "boolean" }).default(false),
  created_at: integer("created_at", { mode: "timestamp" }).notNull()
});

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
```

#### Agent Configuration

```typescript
import { drizzle } from "drizzle-orm/d1";
import { drizzle as drizzleSqlite } from "drizzle-orm/durable-objects";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "./schema";

type DatabaseConfig =
  | { type: "local-sqlite" }
  | { type: "d1"; binding: D1Database };

export class TodoAgent extends Agent<Env, {}> {
  private db: ReturnType<typeof drizzle>;
  private dbConfig: DatabaseConfig;
  private userIdFilter?: string; // Populated for shared databases

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Determine database configuration
    this.dbConfig = env.USE_D1
      ? { type: "d1", binding: env.DB }
      : { type: "local-sqlite" };

    // Initialize Drizzle with appropriate adapter
    if (this.dbConfig.type === "d1") {
      this.db = drizzle(this.dbConfig.binding, { schema });
      this.userIdFilter = this.name; // Use DO name as userId for filtering
    } else {
      this.db = drizzleSqlite(this.ctx.storage, { schema });
      this.userIdFilter = undefined; // No filtering needed for local SQLite
    }

    // Register queries with automatic filtering
    this.registerQuery<{ completed?: boolean }, Todo>(
      "getTodos",
      async (args) => {
        let query = this.db
          .select()
          .from(schema.todos)
          .orderBy(desc(schema.todos.created_at));

        // Build filters array
        const filters = [];

        // CRITICAL: Add userId filter for shared databases
        if (this.userIdFilter) {
          filters.push(eq(schema.todos.userId, this.userIdFilter));
        }

        // Add user-specified filters
        if (args.completed !== undefined) {
          filters.push(eq(schema.todos.completed, args.completed));
        }

        if (filters.length > 0) {
          query = query.where(and(...filters));
        }

        return await query;
      },
      { dependencies: ["todos"] }
    );

    // Register mutations with automatic userId injection
    this.registerMutation<{ text: string }, { id: string }>(
      "addTodo",
      async (args) => {
        const id = nanoid();
        const newTodo: NewTodo = {
          id,
          text: args.text,
          userId: this.userIdFilter, // Include userId for D1, undefined for local SQLite
          completed: false,
          created_at: new Date()
        };

        await this.db.insert(schema.todos).values(newTodo);
        return { id };
      },
      { invalidates: ["getTodos"] }
    );
  }
}
```

#### Automatic Query Filtering

The system automatically adds `userId` filtering when using shared databases:

**Local SQLite (default):**

```sql
-- No userId filter needed - already isolated per DO
SELECT * FROM todos WHERE completed = 0 ORDER BY created_at DESC
```

**D1 (shared database):**

```sql
-- Automatic userId filter added (userId = this.name)
SELECT * FROM todos
WHERE user_id = 'user-123' AND completed = 0
ORDER BY created_at DESC
```

#### Database Configuration

```jsonc
// wrangler.jsonc

// Option 1: Use local SQLite (default)
{
  "name": "todo-agent",
  "durable_objects": {
    "bindings": [
      { "name": "TodoAgent", "class_name": "TodoAgent" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["TodoAgent"]  // Enable SQLite storage
    }
  ],
  "vars": {
    "USE_D1": "false"
  }
}

// Option 2: Use D1 (shared database)
{
  "name": "todo-agent",
  "durable_objects": {
    "bindings": [
      { "name": "TodoAgent", "class_name": "TodoAgent" }
    ]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "todos-db",
      "database_id": "xxxx"
    }
  ],
  "vars": {
    "USE_D1": "true"
  }
}
```

#### Benefits of This Approach

1. **Flexible Storage**: Choose between local SQLite (fast, isolated) or D1 (unlimited, shared)
2. **Type Safety**: Drizzle provides full TypeScript types for all queries
3. **Automatic Filtering**: No manual userId filtering needed - framework handles it
4. **Same API**: Queries work identically regardless of storage backend
5. **Migration Path**: Start with SQLite, migrate to D1 when you hit 10GB limit
6. **Multi-tenancy**: D1 mode enables true multi-tenant architecture with shared database

#### Storage Limits & Recommendations

| Backend          | Limit              | Isolation             | Best For                                |
| ---------------- | ------------------ | --------------------- | --------------------------------------- |
| **Local SQLite** | 10GB per DO        | Per-user              | Small to medium datasets, fast access   |
| **D1**           | No practical limit | Shared with filtering | Large datasets, analytics, multi-tenant |
| **Hybrid**       | Mix both           | Configurable          | Hot data in SQLite, cold data in D1     |

**Recommendation**: Start with local SQLite for simplicity and performance. Migrate to D1 when:

- Approaching 10GB limit per user
- Need cross-user analytics
- Want to reduce per-DO storage costs
- Building multi-tenant SaaS

**Dependencies:**

```json
{
  "dependencies": {
    "drizzle-orm": "^0.30.0",
    "@tanstack/react-query": "^5.0.0",
    "agents": "latest"
  },
  "devDependencies": {
    "drizzle-kit": "^0.20.0"
  }
}
```

### Performance Optimization

1. **Query Result Caching**: Cache query results with a short TTL to avoid re-executing identical queries
2. **Batched Broadcasting**: When multiple mutations occur in quick succession, batch the query updates
3. **Selective Broadcasting**: Only send updates to connections subscribed to affected queries
4. **Connection Pooling**: Reuse SQL prepared statements where possible
5. **Database Selection**: Use local SQLite for fast access, D1 for unlimited storage
6. **Pagination Efficiency**: Only re-fetch affected pages, not entire datasets

### Type Safety

Use TypeScript generics and helper types to ensure end-to-end type safety:

```typescript
// Define query/mutation types centrally
export type TodoQueries = {
  getTodos: { args: { completed?: boolean }; result: Todo };
  getTodo: { args: { id: string }; result: Todo };
};

export type TodoMutations = {
  addTodo: { args: { text: string }; result: { id: string } };
  toggleTodo: { args: { id: string; completed: boolean }; result: void };
  deleteTodo: { args: { id: string }; result: void };
};

// Type-safe hooks
function useDurableQuery<
  Q extends keyof TodoQueries
>(
  agent: ReturnType<typeof useAgent>,
  queryName: Q,
  args: TodoQueries[Q]['args']
): { data: TodoQueries[Q]['result'][] | undefined; ... }
```

### Error Handling

1. **Query Errors**: Send error messages back to subscribed clients
2. **Mutation Errors**: Return error in mutation result message
3. **Connection Errors**: Implement exponential backoff for reconnection
4. **Subscription Cleanup**: Ensure orphaned subscriptions are removed

### Testing Strategy

1. **Unit Tests**:
   - Test `QuerySubscriptionManager` in isolation
   - Test query/mutation registration and execution
   - Test message serialization/deserialization

2. **Integration Tests**:
   - Test full client-server flow with Miniflare/workerd
   - Test multiple clients receiving updates
   - Test hibernation and reconnection scenarios
   - Test cleanup on disconnect

3. **E2E Tests**:
   - Test real application scenarios
   - Test network interruptions
   - Test race conditions with rapid mutations

## Alternative Approaches Considered

### 1. Using Existing State System

**Pros**: No new infrastructure needed
**Cons**: Sends entire state on every change, no query-specific subscriptions

### 2. GraphQL Subscriptions

**Pros**: Industry standard, rich tooling
**Cons**: Heavy dependency, complex setup, overkill for simple use cases

### 3. Event-Based Invalidation

**Pros**: More granular control
**Cons**: Manual event emission required, harder to maintain

## Conclusion

This design leverages the existing Agent infrastructure (SQL, WebSocket, broadcasting) while adding a structured query/mutation layer. It provides React Query-like ergonomics with real-time synchronization across all connected clients, handling Durable Object hibernation gracefully.

The implementation is backwards-compatible and can be added incrementally without breaking existing Agent functionality.

## Next Steps

1. Get feedback on the proposed architecture
2. Create proof-of-concept implementation
3. Build example application to validate design
4. Iterate based on real-world usage
5. Write comprehensive documentation
6. Create migration guide for existing applications

## Questions for Discussion

1. Should we support optimistic updates at the framework level?
2. ~~How should we handle query pagination?~~ ✅ **Resolved**: Support both cursor-based (recommended) and offset-based pagination with `useDurableInfiniteQuery` hook
3. Should mutations support rollback on error?
4. What's the right balance between caching and freshness?
5. Should we expose raw SQL subscriptions or stick to named queries?
6. How do we handle schema migrations for query subscriptions?
