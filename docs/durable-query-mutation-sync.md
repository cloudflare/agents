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

1. **Client-Side Hooks**: Provide `useDurableQuery` and `useDurableMutation` React hooks
2. **Server-Side Query Registry**: Define queries and mutations inside the Agent/Durable Object
3. **Automatic Synchronization**: Broadcast query results when data changes
4. **Hibernation-Aware**: Handle WebSocket reconnection and query re-subscription after hibernation
5. **Type Safety**: Full TypeScript support for queries and mutations
6. **Efficient Broadcasting**: Only broadcast to clients subscribed to affected queries
7. **Optimistic Updates**: Support optimistic UI updates before server confirmation

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
  CF_AGENT_MUTATION = "cf_agent_mutation",
  CF_AGENT_MUTATION_RESULT = "cf_agent_mutation_result"
}
```

### Core Components

#### 1. Query Registry (Server-Side)

Store query definitions in the Agent class:

```typescript
export type QueryDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (args: TArgs, agent: Agent) => TResult[] | Promise<TResult[]>;
  dependencies?: string[]; // Table names that affect this query
};

export type MutationDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (args: TArgs, agent: Agent) => TResult | Promise<TResult>;
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

Track which connections are subscribed to which queries:

```typescript
// Store in SQL for persistence across hibernation
// cf_agents_query_subscriptions table schema:
// - connection_id: TEXT
// - query_name: TEXT
// - query_args: TEXT (JSON serialized)
// - subscribed_at: INTEGER

export class QuerySubscriptionManager {
  constructor(private agent: Agent) {}

  subscribe(connectionId: string, queryName: string, args: unknown) {
    // Store subscription in SQL
    this.agent.sql`
      INSERT OR REPLACE INTO cf_agents_query_subscriptions 
      (connection_id, query_name, query_args, subscribed_at)
      VALUES (${connectionId}, ${queryName}, ${JSON.stringify(args)}, ${Date.now()})
    `;
  }

  unsubscribe(connectionId: string, queryName: string, args: unknown) {
    const argsJson = JSON.stringify(args);
    this.agent.sql`
      DELETE FROM cf_agents_query_subscriptions 
      WHERE connection_id = ${connectionId} 
      AND query_name = ${queryName}
      AND query_args = ${argsJson}
    `;
  }

  getSubscriptions(connectionId: string) {
    return this.agent.sql<{
      query_name: string;
      query_args: string;
    }>`
      SELECT query_name, query_args 
      FROM cf_agents_query_subscriptions 
      WHERE connection_id = ${connectionId}
    `;
  }

  getSubscribersForQuery(queryName: string) {
    return this.agent.sql<{
      connection_id: string;
      query_args: string;
    }>`
      SELECT connection_id, query_args 
      FROM cf_agents_query_subscriptions 
      WHERE query_name = ${queryName}
    `;
  }

  cleanupConnection(connectionId: string) {
    this.agent.sql`
      DELETE FROM cf_agents_query_subscriptions 
      WHERE connection_id = ${connectionId}
    `;
  }
}
```

#### 3. Query Execution & Broadcasting

```typescript
// In Agent class
private async executeQuery(queryName: string, args: unknown) {
  const queryDef = this.queries.get(queryName);
  if (!queryDef) {
    throw new Error(`Query ${queryName} not found`);
  }
  return await queryDef.execute(args, this);
}

private async broadcastQueryUpdate(queryName: string) {
  const subscribers = this.subscriptionManager.getSubscribersForQuery(queryName);

  for (const sub of subscribers) {
    const args = JSON.parse(sub.query_args);
    const data = await this.executeQuery(queryName, args);

    const connection = this.getConnections().find(c => c.id === sub.connection_id);
    if (connection) {
      connection.send(JSON.stringify({
        type: MessageType.CF_AGENT_QUERY_DATA,
        queryName,
        args,
        data,
        timestamp: Date.now()
      }));
    }
  }
}

// Trigger broadcasts after mutations
private async executeMutation(mutationName: string, args: unknown) {
  const mutationDef = this.mutations.get(mutationName);
  if (!mutationDef) {
    throw new Error(`Mutation ${mutationName} not found`);
  }

  const result = await mutationDef.execute(args, this);

  // Invalidate and re-broadcast affected queries
  if (mutationDef.invalidates) {
    for (const queryName of mutationDef.invalidates) {
      await this.broadcastQueryUpdate(queryName);
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

#### 5. Client-Side Hooks

##### `useDurableQuery`

```typescript
export function useDurableQuery<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  queryName: string,
  args: TArgs,
  options?: {
    enabled?: boolean;
    refetchOnWindowFocus?: boolean;
    staleTime?: number;
  }
): {
  data: TResult[] | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refetch: () => void;
} {
  const [data, setData] = useState<TResult[] | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const subscriptionIdRef = useRef<string>();

  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    const subscriptionId = nanoid();
    subscriptionIdRef.current = subscriptionId;
    setIsLoading(true);

    // Subscribe to query
    agent.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_QUERY_SUBSCRIBE,
        queryName,
        args,
        subscriptionId
      })
    );

    // Listen for query data updates
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data);

        if (
          message.type === MessageType.CF_AGENT_QUERY_DATA &&
          message.queryName === queryName &&
          JSON.stringify(message.args) === JSON.stringify(args)
        ) {
          setData(message.data);
          setIsLoading(false);
          setError(undefined);
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      }
    };

    agent.addEventListener("message", handleMessage);

    return () => {
      agent.removeEventListener("message", handleMessage);

      // Unsubscribe
      agent.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_QUERY_UNSUBSCRIBE,
          queryName,
          args
        })
      );
    };
  }, [agent, queryName, JSON.stringify(args), enabled]);

  const refetch = useCallback(() => {
    // Re-subscribe to trigger fresh data
    if (subscriptionIdRef.current && enabled) {
      agent.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_QUERY_SUBSCRIBE,
          queryName,
          args,
          subscriptionId: subscriptionIdRef.current
        })
      );
    }
  }, [agent, queryName, args, enabled]);

  return { data, isLoading, error, refetch };
}
```

##### `useDurableMutation`

```typescript
export function useDurableMutation<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  mutationName: string,
  options?: {
    onSuccess?: (result: TResult) => void;
    onError?: (error: Error) => void;
  }
): {
  mutate: (args: TArgs) => Promise<TResult>;
  isLoading: boolean;
  error: Error | undefined;
  data: TResult | undefined;
} {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [data, setData] = useState<TResult | undefined>(undefined);
  const pendingMutationsRef = useRef(
    new Map<
      string,
      {
        resolve: (value: TResult) => void;
        reject: (error: Error) => void;
      }
    >()
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data);

        if (message.type === MessageType.CF_AGENT_MUTATION_RESULT) {
          const pending = pendingMutationsRef.current.get(message.mutationId);
          if (!pending) return;

          if (message.success) {
            setData(message.result);
            setError(undefined);
            pending.resolve(message.result);
            options?.onSuccess?.(message.result);
          } else {
            const err = new Error(message.error);
            setError(err);
            pending.reject(err);
            options?.onError?.(err);
          }

          pendingMutationsRef.current.delete(message.mutationId);
          setIsLoading(false);
        }
      } catch (err) {
        console.error("Error handling mutation result:", err);
      }
    };

    agent.addEventListener("message", handleMessage);
    return () => agent.removeEventListener("message", handleMessage);
  }, [agent, options]);

  const mutate = useCallback(
    async (args: TArgs): Promise<TResult> => {
      return new Promise((resolve, reject) => {
        const mutationId = nanoid();
        pendingMutationsRef.current.set(mutationId, { resolve, reject });

        setIsLoading(true);
        setError(undefined);

        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_MUTATION,
            mutationName,
            args,
            mutationId
          })
        );
      });
    },
    [agent, mutationName]
  );

  return { mutate, isLoading, error, data };
}
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

### Hibernation Strategy

**Challenge**: When a Durable Object hibernates, the Agent instance is destroyed but WebSocket connections persist. On wake-up, we need to restore query subscriptions.

**Solution**:

1. Store all subscriptions in the SQL database (`cf_agents_query_subscriptions` table)
2. On `onConnect`, check if this is a reconnection by looking up existing subscriptions
3. Immediately send current query results for all subscriptions
4. Clean up subscriptions only when the connection is permanently closed

### Performance Optimization

1. **Query Result Caching**: Cache query results with a short TTL to avoid re-executing identical queries
2. **Batched Broadcasting**: When multiple mutations occur in quick succession, batch the query updates
3. **Selective Broadcasting**: Only send updates to connections subscribed to affected queries
4. **Connection Pooling**: Reuse SQL prepared statements where possible

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
2. How should we handle query pagination?
3. Should mutations support rollback on error?
4. What's the right balance between caching and freshness?
5. Should we expose raw SQL subscriptions or stick to named queries?
6. How do we handle schema migrations for query subscriptions?
