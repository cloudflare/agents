import type { PartySocket } from "partysocket";
import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useAgent, type UseAgentOptions } from "./react";
import { useAsyncQuery } from "./use-async-query";

export interface AuthData {
  token?: string;
  userId?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NETWORK_ERROR"
      | "AUTH_FAILED"
      | "TIMEOUT"
      | "INVALID_RESPONSE",
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface RetryConfig {
  attempts: number;
  delay: number;
  backoffMultiplier?: number;
}

export interface CacheConfig {
  ttl?: number;
  staleWhileRevalidate?: boolean;
}

export interface AutoRetryConfig {
  enabled?: boolean;
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  stopAfterMs?: number;
  triggers?: ("focus" | "online" | "visibility" | "periodic")[];
  periodicInterval?: number;
}

export type ConnectionState =
  | "connecting"
  | "connected"
  | "retrying"
  | "failed";

/**
 * Options for the useAsyncAgent hook
 * @template State Type of the Agent's state
 * @template TAuthData Type of the authentication data returned by the query function
 */
export type UseAsyncAgentOptions<
  State = unknown,
  TAuthData extends AuthData = AuthData
> = Omit<UseAgentOptions<State>, "query"> & {
  query: () => Promise<TAuthData>;
  queryDeps?: unknown[];
  onAuthError?: (error: AuthError) => void;
  retryConfig?: RetryConfig;
  cacheConfig?: CacheConfig;
  autoRetry?: AutoRetryConfig;
  debug?: boolean;
};

/**
 * React hook for connecting to an Agent with async query resolution
 * This hook supports async query functions that can fetch authentication tokens,
 * user data, or other dynamic parameters needed for the WebSocket connection.
 * Features automatic retry with event-driven recovery for robust authentication.
 *
 * Note: This hook uses React's Suspense, so the component must be wrapped in a Suspense boundary.
 *
 * @template State Type of the Agent's state
 * @template TAuthData Type of the authentication data returned by the query function
 * @param options Connection options with async query function
 * @returns WebSocket connection with setState, call methods, and connection state
 */
export function useAsyncAgent<
  State = unknown,
  TAuthData extends AuthData = AuthData
>(
  options: UseAsyncAgentOptions<State, TAuthData>
): PartySocket & {
  agent: string;
  name: string;
  setState: (state: State) => void;
  call: ReturnType<typeof useAgent>["call"];
  stub: ReturnType<typeof useAgent>["stub"];
  connectionState: ConnectionState;
  isRetrying: boolean;
  lastError: AuthError | null;
} {
  const {
    query,
    queryDeps,
    onAuthError,
    retryConfig = { attempts: 3, delay: 1000, backoffMultiplier: 2 },
    debug = process.env.NODE_ENV === "development",
    ...restOptions
  } = options;

  // Properly merge autoRetry config with type-safe defaults
  const autoRetryConfig = useMemo(
    () => ({
      enabled: true,
      maxAttempts: 5,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 1.5,
      stopAfterMs: 5 * 60 * 1000, // 5 minutes
      triggers: ["focus", "online", "visibility", "periodic"] as const,
      periodicInterval: 30000, // 30 seconds
      ...options.autoRetry
    }),
    [options.autoRetry]
  );

  // State for automatic retry mechanism
  const [retryKey, setRetryKey] = useState(0);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [isRetrying, setIsRetrying] = useState(false);
  const [lastError, setLastError] = useState<AuthError | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [lastRetryTime, setLastRetryTime] = useState(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const periodicRetryRef = useRef<NodeJS.Timeout | null>(null);

  // Validate query function
  if (!query || typeof query !== "function") {
    throw new Error(
      `useAsyncAgent: 'query' must be a function that returns a Promise. ` +
        `Received: ${typeof query}. ` +
        "Example: query: async () => ({ token: await getAuthToken() })"
    );
  }

  if (debug) {
    console.log(
      `[useAsyncAgent] Connecting to agent "${options.agent}" with async authentication`
    );
  }

  // Batch state updates
  const updateRetryState = useCallback(
    (
      updates: Partial<{
        connectionState: ConnectionState;
        isRetrying: boolean;
        retryCount: number;
        lastError: AuthError | null;
        lastRetryTime: number;
      }>
    ) => {
      if (updates.connectionState !== undefined)
        setConnectionState(updates.connectionState);
      if (updates.isRetrying !== undefined) setIsRetrying(updates.isRetrying);
      if (updates.retryCount !== undefined) setRetryCount(updates.retryCount);
      if (updates.lastError !== undefined) setLastError(updates.lastError);
      if (updates.lastRetryTime !== undefined)
        setLastRetryTime(updates.lastRetryTime);
    },
    []
  );

  // Automatic retry function
  const triggerRetry = useCallback(() => {
    if (!autoRetryConfig.enabled) return;

    const now = Date.now();
    if (now - lastRetryTime < autoRetryConfig.stopAfterMs) {
      if (retryCount < autoRetryConfig.maxAttempts) {
        if (debug) {
          console.log(
            `[useAsyncAgent] Auto-retry ${retryCount + 1}/${autoRetryConfig.maxAttempts} for agent "${options.agent}"`
          );
        }

        // Batch state updates
        updateRetryState({
          isRetrying: true,
          retryCount: retryCount + 1,
          lastRetryTime: now
        });
        setRetryKey((prev) => prev + 1);

        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
        }

        const delay = Math.min(
          autoRetryConfig.baseDelay *
            Math.pow(autoRetryConfig.backoffMultiplier, retryCount),
          autoRetryConfig.maxDelay
        );
        retryTimeoutRef.current = setTimeout(() => {
          setIsRetrying(false);
        }, delay);
      } else {
        if (debug) {
          console.log(
            `[useAsyncAgent] Max retry attempts reached for agent "${options.agent}"`
          );
        }
        updateRetryState({
          connectionState: "failed",
          isRetrying: false
        });
      }
    }
  }, [
    autoRetryConfig,
    lastRetryTime,
    retryCount,
    debug,
    options.agent,
    updateRetryState
  ]);

  useEffect(() => {
    if (!autoRetryConfig.enabled || !autoRetryConfig.triggers) return;

    const handleFocus = () => {
      if (
        autoRetryConfig.triggers.includes("focus") &&
        connectionState === "failed"
      ) {
        if (debug)
          console.log("[useAsyncAgent] Window focus - triggering retry");
        triggerRetry();
      }
    };

    const handleOnline = () => {
      if (
        autoRetryConfig.triggers.includes("online") &&
        connectionState === "failed"
      ) {
        if (debug)
          console.log("[useAsyncAgent] Network online - triggering retry");
        triggerRetry();
      }
    };

    const handleVisibilityChange = () => {
      if (
        autoRetryConfig.triggers.includes("visibility") &&
        !document.hidden &&
        connectionState === "failed"
      ) {
        if (debug)
          console.log("[useAsyncAgent] Page visible - triggering retry");
        triggerRetry();
      }
    };

    // Add event listeners
    if (autoRetryConfig.triggers.includes("focus")) {
      window.addEventListener("focus", handleFocus);
    }
    if (autoRetryConfig.triggers.includes("online")) {
      window.addEventListener("online", handleOnline);
    }
    if (autoRetryConfig.triggers.includes("visibility")) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoRetryConfig, connectionState, triggerRetry, debug]);

  useEffect(() => {
    if (
      !autoRetryConfig.enabled ||
      !autoRetryConfig.triggers.includes("periodic")
    ) {
      return;
    }

    if (periodicRetryRef.current) {
      clearInterval(periodicRetryRef.current);
      periodicRetryRef.current = null;
    }

    // Only start periodic retry when connection is failed
    if (connectionState === "failed") {
      periodicRetryRef.current = setInterval(() => {
        if (debug) console.log("[useAsyncAgent] Periodic retry trigger");
        triggerRetry();
      }, autoRetryConfig.periodicInterval);
    }

    return () => {
      if (periodicRetryRef.current) {
        clearInterval(periodicRetryRef.current);
        periodicRetryRef.current = null;
      }
    };
  }, [autoRetryConfig, connectionState, triggerRetry, debug]);

  const enhancedQuery = async (): Promise<TAuthData> => {
    setConnectionState("connecting");

    try {
      const result = await query();

      if (debug) {
        console.log(
          `[useAsyncAgent] Authentication successful for agent "${options.agent}"`
        );
      }

      // Reset retry state on success
      updateRetryState({
        connectionState: "connected",
        retryCount: 0,
        lastError: null,
        isRetrying: false
      });

      return result;
    } catch (error) {
      const lastError = error as Error;

      if (debug) {
        console.warn(
          `[useAsyncAgent] Authentication failed for agent "${options.agent}":`,
          error
        );
      }

      const authError = new AuthError(
        `Authentication failed for agent "${options.agent}"`,
        lastError?.name === "TypeError" ? "NETWORK_ERROR" : "AUTH_FAILED",
        lastError
      );

      // Set error state for automatic retry system
      updateRetryState({
        lastError: authError,
        connectionState: "failed",
        lastRetryTime: Date.now()
      });

      if (autoRetryConfig.enabled) {
        if (debug) {
          console.log(
            `[useAsyncAgent] Authentication failed, automatic retry enabled for agent "${options.agent}"`
          );
        }
      }

      if (onAuthError) {
        onAuthError(authError);
      }

      throw authError;
    }
  };

  const cacheKey = useMemo(
    () =>
      `async_agent_${options.agent}_${options.name || "default"}_${retryKey}`,
    [options.agent, options.name, retryKey]
  );

  const resolvedQuery = useAsyncQuery(
    enhancedQuery,
    [...(queryDeps || []), retryKey],
    {
      skipFunctionHash: true,
      cacheKey,
      ttl: options.cacheConfig?.ttl,
      forceRefresh: retryKey > 0
    }
  );

  const validatedQuery = useMemo(() => {
    if (!resolvedQuery) return undefined;

    if (debug) {
      const hasAuthFields =
        resolvedQuery.token ||
        resolvedQuery.sessionId ||
        resolvedQuery.userId ||
        resolvedQuery.authorization ||
        resolvedQuery.apiKey;

      if (!hasAuthFields) {
        console.warn(
          `[useAsyncAgent] No common authentication fields detected for agent "${options.agent}". ` +
            "Expected fields: token, sessionId, userId, authorization, or apiKey. " +
            "Received fields: " +
            Object.keys(resolvedQuery).join(", ")
        );
      }
    }

    // Transform the resolved query to match WebSocket query parameter requirements
    const query: Record<string, string | null | undefined> = {};

    for (const [key, value] of Object.entries(resolvedQuery)) {
      if (value === null || value === undefined) {
        query[key] = value;
      } else if (typeof value === "string") {
        query[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        query[key] = String(value);
      } else {
        query[key] = JSON.stringify(value);
      }
    }

    return query;
  }, [resolvedQuery, debug, options.agent]);

  const agent = useAgent({
    ...restOptions,
    query: validatedQuery
  });

  return {
    ...agent,
    connectionState,
    isRetrying,
    lastError
  } as PartySocket & {
    agent: string;
    name: string;
    setState: (state: State) => void;
    call: ReturnType<typeof useAgent>["call"];
    stub: ReturnType<typeof useAgent>["stub"];
    connectionState: ConnectionState;
    isRetrying: boolean;
    lastError: AuthError | null;
  };
}
