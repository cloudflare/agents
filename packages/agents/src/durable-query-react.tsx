import { useEffect, useState, useCallback, useRef } from "react";
import { MessageType } from "./ai-types";
import type PartySocket from "partysocket";

export interface UseDurableQueryOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchOnWindowFocus?: boolean;
}

export interface UseDurableQueryResult<TResult> {
  data: TResult[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  isFetching: boolean;
}

export function useDurableQuery<TArgs = unknown, TResult = unknown>(
  agent: PartySocket,
  queryName: string,
  args: TArgs,
  options: UseDurableQueryOptions = {}
): UseDurableQueryResult<TResult> {
  const {
    enabled = true,
    staleTime = 0,
    refetchOnWindowFocus = false
  } = options;

  const [data, setData] = useState<TResult[] | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const subscriptionIdRef = useRef<string | undefined>(undefined);
  const lastFetchTimeRef = useRef<number>(0);

  const fetchData = useCallback(() => {
    if (!enabled) return;

    const now = Date.now();
    if (staleTime > 0 && now - lastFetchTimeRef.current < staleTime) {
      return;
    }

    const subscriptionId = Math.random().toString(36).slice(2);
    subscriptionIdRef.current = subscriptionId;

    setIsFetching(true);

    agent.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_QUERY_SUBSCRIBE,
        queryName,
        args,
        subscriptionId
      })
    );

    lastFetchTimeRef.current = now;
  }, [agent, queryName, JSON.stringify(args), enabled, staleTime]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === MessageType.CF_AGENT_QUERY_DATA) {
          if (
            message.queryName === queryName &&
            JSON.stringify(message.args) === JSON.stringify(args)
          ) {
            setData(message.data);
            setIsLoading(false);
            setIsFetching(false);
            setError(null);
          }
        } else if (message.type === MessageType.CF_AGENT_QUERY_ERROR) {
          if (message.queryName === queryName) {
            setError(new Error(message.error));
            setIsLoading(false);
            setIsFetching(false);
          }
        }
      } catch (e) {}
    };

    agent.addEventListener("message", handleMessage);

    fetchData();

    const handleFocus = () => {
      if (refetchOnWindowFocus) {
        fetchData();
      }
    };

    if (refetchOnWindowFocus) {
      window.addEventListener("focus", handleFocus);
    }

    return () => {
      agent.removeEventListener("message", handleMessage);
      if (refetchOnWindowFocus) {
        window.removeEventListener("focus", handleFocus);
      }

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
    enabled,
    fetchData,
    refetchOnWindowFocus
  ]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    isLoading,
    error,
    refetch,
    isFetching
  };
}

export interface UseDurableMutationOptions<TResult, TArgs> {
  onSuccess?: (result: TResult, variables: TArgs) => void | Promise<void>;
  onError?: (error: Error, variables: TArgs) => void | Promise<void>;
  onMutate?: (variables: TArgs) => void | Promise<void>;
}

export interface UseDurableMutationResult<TResult, TArgs> {
  mutate: (args: TArgs) => void;
  mutateAsync: (args: TArgs) => Promise<TResult>;
  isPending: boolean;
  error: Error | null;
  data: TResult | undefined;
}

export function useDurableMutation<TArgs = unknown, TResult = unknown>(
  agent: PartySocket,
  mutationName: string,
  options: UseDurableMutationOptions<TResult, TArgs> = {}
): UseDurableMutationResult<TResult, TArgs> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<TResult | undefined>(undefined);
  const pendingMutationsRef = useRef<
    Map<
      string,
      {
        resolve: (value: TResult) => void;
        reject: (error: Error) => void;
      }
    >
  >(new Map());

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === MessageType.CF_AGENT_MUTATION_RESULT) {
          const pending = pendingMutationsRef.current.get(message.mutationId);
          if (pending) {
            pendingMutationsRef.current.delete(message.mutationId);

            if (message.success) {
              setData(message.result);
              setError(null);
              pending.resolve(message.result);
            } else {
              const err = new Error(message.error);
              setError(err);
              pending.reject(err);
            }

            setIsPending(pendingMutationsRef.current.size > 0);
          }
        }
      } catch (e) {}
    };

    agent.addEventListener("message", handleMessage);

    return () => {
      agent.removeEventListener("message", handleMessage);
    };
  }, [agent]);

  const mutateAsync = useCallback(
    async (args: TArgs): Promise<TResult> => {
      const mutationId = `${mutationName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      setIsPending(true);
      setError(null);

      if (options.onMutate) {
        await options.onMutate(args);
      }

      return new Promise<TResult>((resolve, reject) => {
        pendingMutationsRef.current.set(mutationId, { resolve, reject });

        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_MUTATION,
            mutationName,
            args,
            mutationId
          })
        );
      })
        .then(async (result) => {
          if (options.onSuccess) {
            await options.onSuccess(result, args);
          }
          return result;
        })
        .catch(async (err) => {
          if (options.onError) {
            await options.onError(err, args);
          }
          throw err;
        });
    },
    [agent, mutationName, options]
  );

  const mutate = useCallback(
    (args: TArgs) => {
      mutateAsync(args).catch(() => {});
    },
    [mutateAsync]
  );

  return {
    mutate,
    mutateAsync,
    isPending,
    error,
    data
  };
}

export interface UseDurableInfiniteQueryOptions<TResult> {
  enabled?: boolean;
  getNextPageParam: (lastPage: TResult[]) => unknown | undefined;
}

export interface UseDurableInfiniteQueryResult<TResult> {
  data: TResult[];
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
  refetch: () => void;
  isLoading: boolean;
}

export function useDurableInfiniteQuery<TArgs = unknown, TResult = unknown>(
  agent: PartySocket,
  queryName: string,
  baseArgs: TArgs,
  options: UseDurableInfiniteQueryOptions<TResult>
): UseDurableInfiniteQueryResult<TResult> {
  const { enabled = true, getNextPageParam } = options;

  const [pages, setPages] = useState<TResult[][]>([]);
  const [cursors, setCursors] = useState<unknown[]>([undefined]);
  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const currentCursor = cursors[cursors.length - 1];
  const queryArgs = { ...baseArgs, cursor: currentCursor } as TArgs;

  const currentPageQuery = useDurableQuery<TArgs, TResult>(
    agent,
    queryName,
    queryArgs,
    { enabled }
  );

  useEffect(() => {
    if (currentPageQuery.data && !currentPageQuery.isLoading) {
      setPages((prev) => {
        const newPages = [...prev];
        newPages[cursors.length - 1] = currentPageQuery.data!;
        return newPages;
      });
      setIsFetchingNextPage(false);
      setIsLoading(false);
    }
  }, [currentPageQuery.data, currentPageQuery.isLoading, cursors.length]);

  const hasNextPage = currentPageQuery.data
    ? getNextPageParam(currentPageQuery.data) !== undefined
    : false;

  const fetchNextPage = useCallback(() => {
    if (!currentPageQuery.data || !hasNextPage) return;

    const nextCursor = getNextPageParam(currentPageQuery.data);
    setCursors((prev) => [...prev, nextCursor]);
    setIsFetchingNextPage(true);
  }, [currentPageQuery.data, hasNextPage, getNextPageParam]);

  const refetch = useCallback(() => {
    setCursors([undefined]);
    setPages([]);
    currentPageQuery.refetch();
  }, [currentPageQuery]);

  const flatData = pages.flat();

  return {
    data: flatData,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
    isLoading
  };
}
