# TanStack Query Integration for Durable Query/Mutation Sync

This document outlines how to integrate **TanStack Query (React Query)** as the foundation for the client-side hooks, providing battle-tested caching, deduplication, and state management while adding real-time WebSocket synchronization on top.

## Why TanStack Query?

TanStack Query provides:

- **Proven caching layer**: Automatic request deduplication and smart caching
- **Background refetching**: Keep data fresh automatically
- **DevTools**: Rich debugging experience
- **Optimistic updates**: Built-in support for immediate UI updates
- **TypeScript**: Full type safety
- **Framework agnostic**: Core logic can work across React, Vue, Solid, etc.

By building on TanStack Query, we avoid reinventing the wheel and gain a mature ecosystem while adding our real-time sync layer.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                 React Component                      │
│                                                      │
│  useDurableQuery('getTodos', { completed: false })  │
└──────────────┬───────────────────────────┬──────────┘
               │                           │
               │ Initial fetch             │ Real-time updates
               ▼                           ▼
┌──────────────────────────┐   ┌──────────────────────┐
│   TanStack Query Cache   │◄──│  WebSocket Listener  │
│                          │   │                      │
│  - Caching               │   │  - Subscribe         │
│  - Deduplication         │   │  - Listen for updates│
│  - Background refetch    │   │  - Update cache      │
│  - Stale management      │   │                      │
└──────────┬───────────────┘   └──────────┬───────────┘
           │                               │
           │ Query function                │ WebSocket messages
           ▼                               ▼
┌─────────────────────────────────────────────────────┐
│              Agent (Durable Object)                  │
│                                                      │
│  - Execute queries                                   │
│  - Track subscriptions                               │
│  - Broadcast updates                                 │
└─────────────────────────────────────────────────────┘
```

## Updated Client Hook Implementations

### Dependencies

```json
{
  "dependencies": {
    "@tanstack/react-query": "^5.0.0",
    "agents": "latest"
  }
}
```

### QueryClient Setup

```typescript
// app.tsx or root component
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000, // Consider data fresh for 1 second
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
```

### `useDurableQuery` Hook

```typescript
import {
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { nanoid } from "nanoid";
import type { useAgent } from "agents/react";
import { MessageType } from "agents/ai-types";

export function useDurableQuery<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  queryName: string,
  args: TArgs,
  options?: Omit<UseQueryOptions<TResult[], Error>, "queryKey" | "queryFn">
) {
  const queryClient = useQueryClient();
  const subscriptionIdRef = useRef<string>();
  const isSubscribedRef = useRef(false);

  // Create stable query key
  const queryKey = [
    "durable",
    agent.agent,
    agent.name,
    queryName,
    args
  ] as const;

  // Use TanStack Query for caching and state management
  const query = useQuery<TResult[], Error>({
    queryKey,
    queryFn: async ({ signal }) => {
      // Initial fetch via subscription
      return new Promise((resolve, reject) => {
        const subscriptionId = nanoid();
        subscriptionIdRef.current = subscriptionId;

        // Handle abort signal
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new Error("Query aborted"));
          });
        }

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Query timeout"));
        }, 10000);

        const handleMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;

          try {
            const message = JSON.parse(event.data);

            if (
              message.type === MessageType.CF_AGENT_QUERY_DATA &&
              message.subscriptionId === subscriptionId
            ) {
              clearTimeout(timeout);
              cleanup();
              resolve(message.data);
            }
          } catch (err) {
            cleanup();
            reject(err);
          }
        };

        const cleanup = () => {
          agent.removeEventListener("message", handleMessage);
        };

        agent.addEventListener("message", handleMessage);

        // Subscribe to query
        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_SUBSCRIBE,
            queryName,
            args,
            subscriptionId
          })
        );
      });
    },
    ...options
  });

  // Set up real-time subscription for updates after initial load
  useEffect(() => {
    if (query.data === undefined || isSubscribedRef.current) return;

    isSubscribedRef.current = true;
    const subscriptionId = subscriptionIdRef.current || nanoid();
    subscriptionIdRef.current = subscriptionId;

    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data);

        if (
          message.type === MessageType.CF_AGENT_QUERY_DATA &&
          message.queryName === queryName &&
          JSON.stringify(message.args) === JSON.stringify(args)
        ) {
          // Update TanStack Query cache with new data from real-time updates
          queryClient.setQueryData(queryKey, message.data);
        }
      } catch (err) {
        console.error("Error handling query update:", err);
      }
    };

    agent.addEventListener("message", handleMessage);

    return () => {
      isSubscribedRef.current = false;
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
  }, [
    agent,
    queryName,
    JSON.stringify(args),
    queryClient,
    queryKey,
    query.data
  ]);

  return query;
}
```

**Usage:**

```typescript
const { data, isLoading, error, refetch, isFetching, isStale } =
  useDurableQuery(
    agent,
    "getTodos",
    { completed: false },
    {
      staleTime: 5000,
      refetchOnWindowFocus: true,
      enabled: true
      // All TanStack Query options available
    }
  );
```

### `useDurableMutation` Hook

```typescript
import {
  useMutation,
  useQueryClient,
  type UseMutationOptions
} from "@tanstack/react-query";
import { useRef } from "react";
import { nanoid } from "nanoid";
import type { useAgent } from "agents/react";
import { MessageType } from "agents/ai-types";

export function useDurableMutation<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  mutationName: string,
  options?: Omit<UseMutationOptions<TResult, Error, TArgs>, "mutationFn">
) {
  const queryClient = useQueryClient();
  const pendingMutationsRef = useRef(
    new Map<
      string,
      {
        resolve: (value: TResult) => void;
        reject: (error: Error) => void;
      }
    >()
  );

  const mutation = useMutation<TResult, Error, TArgs>({
    mutationFn: async (args: TArgs) => {
      return new Promise((resolve, reject) => {
        const mutationId = nanoid();
        pendingMutationsRef.current.set(mutationId, { resolve, reject });

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Mutation timeout"));
        }, 30000);

        const handleMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;

          try {
            const message = JSON.parse(event.data);

            if (
              message.type === MessageType.CF_AGENT_MUTATION_RESULT &&
              message.mutationId === mutationId
            ) {
              clearTimeout(timeout);
              cleanup();
              pendingMutationsRef.current.delete(mutationId);

              if (message.success) {
                resolve(message.result);
              } else {
                reject(new Error(message.error));
              }
            }
          } catch (err) {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        const cleanup = () => {
          agent.removeEventListener("message", handleMessage);
        };

        agent.addEventListener("message", handleMessage);

        // Send mutation request
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
    ...options,
    // Wrap onSuccess to handle query invalidation
    onSuccess: (data, variables, context) => {
      // TanStack Query will handle invalidation based on returned data
      // The server should broadcast query updates automatically
      options?.onSuccess?.(data, variables, context);
    }
  });

  return mutation;
}
```

**Usage:**

```typescript
const { mutate, mutateAsync, isPending, error, data } = useDurableMutation(
  agent,
  "addTodo",
  {
    onSuccess: (result) => {
      console.log("Todo added:", result);
      // No need to manually invalidate - server broadcasts updates
    },
    onError: (error) => {
      console.error("Failed to add todo:", error);
    }
  }
);

// Use mutate for fire-and-forget
mutate({ text: "New todo" });

// Use mutateAsync for async/await
await mutateAsync({ text: "New todo" });
```

### `useDurableInfiniteQuery` Hook

```typescript
import {
  useInfiniteQuery,
  useQueryClient,
  type UseInfiniteQueryOptions
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { nanoid } from "nanoid";
import type { useAgent } from "agents/react";
import { MessageType } from "agents/ai-types";

export function useDurableInfiniteQuery<
  TArgs extends Record<string, any>,
  TResult
>(
  agent: ReturnType<typeof useAgent>,
  queryName: string,
  baseArgs: Omit<TArgs, "cursor">,
  options: Omit<
    UseInfiniteQueryOptions<TResult[], Error>,
    "queryKey" | "queryFn" | "initialPageParam"
  > & {
    getNextPageParam: (
      lastPage: TResult[],
      allPages: TResult[][]
    ) => string | undefined;
  }
) {
  const queryClient = useQueryClient();
  const subscriptionsRef = useRef(new Set<string>());

  // Create stable query key
  const queryKey = [
    "durable-infinite",
    agent.agent,
    agent.name,
    queryName,
    baseArgs
  ] as const;

  const query = useInfiniteQuery<TResult[], Error>({
    queryKey,
    initialPageParam: undefined,
    queryFn: async ({ pageParam, signal }) => {
      const args = { ...baseArgs, cursor: pageParam } as TArgs;

      return new Promise((resolve, reject) => {
        const subscriptionId = nanoid();
        subscriptionsRef.current.add(subscriptionId);

        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new Error("Query aborted"));
          });
        }

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Query timeout"));
        }, 10000);

        const handleMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;

          try {
            const message = JSON.parse(event.data);

            if (
              message.type === MessageType.CF_AGENT_QUERY_DATA &&
              message.subscriptionId === subscriptionId
            ) {
              clearTimeout(timeout);
              cleanup();
              resolve(message.data);
            }
          } catch (err) {
            cleanup();
            reject(err);
          }
        };

        const cleanup = () => {
          agent.removeEventListener("message", handleMessage);
          subscriptionsRef.current.delete(subscriptionId);
        };

        agent.addEventListener("message", handleMessage);

        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_SUBSCRIBE,
            queryName,
            args,
            subscriptionId
          })
        );
      });
    },
    getNextPageParam: options.getNextPageParam,
    ...options
  });

  // Set up real-time updates for all loaded pages
  useEffect(() => {
    if (!query.data) return;

    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data);

        if (
          message.type === MessageType.CF_AGENT_QUERY_DATA &&
          message.queryName === queryName
        ) {
          // Check if this update matches any of our loaded pages
          const messageArgs = message.args;
          const basePart = { ...baseArgs };

          // If the base args match, update the appropriate page
          if (
            JSON.stringify(
              Object.keys(basePart).reduce((acc, key) => {
                acc[key] = messageArgs[key];
                return acc;
              }, {} as any)
            ) === JSON.stringify(basePart)
          ) {
            // Find which page this cursor corresponds to
            const cursor = messageArgs.cursor;
            const pageIndex = query.data.pages.findIndex((_, idx) => {
              // Match cursor to page
              return idx === 0 ? !cursor : true; // Simplified - needs proper cursor matching
            });

            if (pageIndex >= 0) {
              // Update specific page
              queryClient.setQueryData(queryKey, (old: any) => {
                if (!old) return old;
                const newPages = [...old.pages];
                newPages[pageIndex] = message.data;
                return { ...old, pages: newPages };
              });
            }
          }
        }
      } catch (err) {
        console.error("Error handling infinite query update:", err);
      }
    };

    agent.addEventListener("message", handleMessage);

    return () => {
      agent.removeEventListener("message", handleMessage);

      // Clean up all page subscriptions
      subscriptionsRef.current.forEach((subId) => {
        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_UNSUBSCRIBE,
            queryName,
            args: baseArgs
          })
        );
      });
      subscriptionsRef.current.clear();
    };
  }, [agent, queryName, baseArgs, queryClient, queryKey, query.data]);

  return query;
}
```

**Usage:**

```typescript
const {
  data, // { pages: TResult[][], pageParams: any[] }
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  refetch
} = useDurableInfiniteQuery(
  agent,
  "getTodos",
  { completed: false },
  {
    getNextPageParam: (lastPage) => {
      if (lastPage.length <= 20) return undefined;
      return lastPage[lastPage.length - 1].created_at;
    }
  }
);

// Flatten all pages
const allTodos = data?.pages.flat() ?? [];
```

## Advanced Patterns

### Optimistic Updates

TanStack Query's built-in optimistic updates work seamlessly:

```typescript
const { mutate } = useDurableMutation(agent, "addTodo", {
  onMutate: async (newTodo) => {
    // Cancel outgoing refetches
    await queryClient.cancelQueries({
      queryKey: ["durable", agent.agent, agent.name, "getTodos"]
    });

    // Snapshot previous value
    const previousTodos = queryClient.getQueryData([
      "durable",
      agent.agent,
      agent.name,
      "getTodos",
      {}
    ]);

    // Optimistically update
    queryClient.setQueryData(
      ["durable", agent.agent, agent.name, "getTodos", {}],
      (old: Todo[]) => [
        ...old,
        { id: "temp-" + Date.now(), ...newTodo, completed: false }
      ]
    );

    return { previousTodos };
  },
  onError: (err, newTodo, context) => {
    // Rollback on error
    queryClient.setQueryData(
      ["durable", agent.agent, agent.name, "getTodos", {}],
      context?.previousTodos
    );
  },
  onSettled: () => {
    // Real-time update will come via WebSocket
    // TanStack Query will merge it with the cache
  }
});
```

### Prefetching

```typescript
const queryClient = useQueryClient();

// Prefetch on hover
const handleMouseEnter = () => {
  queryClient.prefetchQuery({
    queryKey: [
      "durable",
      agent.agent,
      agent.name,
      "getTodoDetail",
      { id: "123" }
    ],
    queryFn: () => {
      // This will use the same WebSocket subscription mechanism
      return fetchTodoDetail(agent, "123");
    }
  });
};
```

### Dependent Queries

```typescript
const { data: user } = useDurableQuery(agent, "getUser", { id: userId });

// Only fetch todos after user is loaded
const { data: todos } = useDurableQuery(
  agent,
  "getUserTodos",
  { userId: user?.id },
  {
    enabled: !!user?.id
  }
);
```

### Query Invalidation from Mutations

The server automatically broadcasts updates, but you can also manually invalidate:

```typescript
const { mutate } = useDurableMutation(agent, "deleteTodo", {
  onSuccess: () => {
    // Manually trigger refetch if needed (usually not necessary)
    queryClient.invalidateQueries({
      queryKey: ["durable", agent.agent, agent.name, "getTodos"]
    });
  }
});
```

## Benefits of TanStack Query Integration

1. **Proven Reliability**: Battle-tested by thousands of production applications
2. **Rich Feature Set**: Automatic retries, polling, prefetching, etc.
3. **DevTools**: Inspect cache, queries, and mutations in real-time
4. **Performance**: Smart caching and deduplication out of the box
5. **Type Safety**: Full TypeScript support with generics
6. **Ecosystem**: Plugins, utilities, and community support
7. **Framework Flexibility**: Can extend to Vue, Solid, Svelte with TanStack Query variants

## Migration from Basic Hooks

If you've already implemented basic hooks, migration is straightforward:

**Before:**

```typescript
const { data, isLoading, error } = useDurableQuery(agent, "getTodos", {});
```

**After:**

```typescript
const { data, isLoading, error } = useDurableQuery(agent, "getTodos", {});
// Same API! Just add QueryClientProvider to your app root
```

The hooks maintain the same API surface while gaining TanStack Query's capabilities under the hood.

## Next Steps

1. Implement core hooks with TanStack Query foundation
2. Test caching behavior and real-time sync interaction
3. Validate optimistic updates work correctly
4. Add comprehensive examples to documentation
5. Create migration guide for existing applications
