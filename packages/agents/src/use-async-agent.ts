import type { PartySocket } from "partysocket";
import { useMemo } from "react";
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
  debug?: boolean;
};

/**
 * React hook for connecting to an Agent with async query resolution
 * This hook supports async query functions that can fetch authentication tokens,
 * user data, or other dynamic parameters needed for the WebSocket connection.
 *
 * Note: This hook uses React's Suspense, so the component must be wrapped in a Suspense boundary.
 *
 * @template State Type of the Agent's state
 * @template TAuthData Type of the authentication data returned by the query function
 * @param options Connection options with async query function
 * @returns WebSocket connection with setState and call methods
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
} {
  const {
    query,
    queryDeps,
    onAuthError,
    retryConfig = { attempts: 3, delay: 1000, backoffMultiplier: 2 },
    debug = process.env.NODE_ENV === "development",
    ...restOptions
  } = options;

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

  // Enhanced query function with error handling and retry logic
  const enhancedQuery = async (): Promise<TAuthData> => {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retryConfig.attempts; attempt++) {
      try {
        if (debug && attempt > 1) {
          console.log(
            `[useAsyncAgent] Retry attempt ${attempt}/${retryConfig.attempts} for agent "${options.agent}"`
          );
        }

        const result = await query();

        if (debug) {
          console.log(
            `[useAsyncAgent] Authentication successful for agent "${options.agent}"`
          );
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        if (debug) {
          console.warn(
            `[useAsyncAgent] Auth attempt ${attempt} failed for agent "${options.agent}":`,
            error
          );
        }

        // Don't retry on the last attempt
        if (attempt < retryConfig.attempts) {
          const delay =
            retryConfig.delay *
            (retryConfig.backoffMultiplier || 2) ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const authError = new AuthError(
      `Authentication failed after ${retryConfig.attempts} attempts for agent "${options.agent}"`,
      lastError?.name === "TypeError" ? "NETWORK_ERROR" : "AUTH_FAILED",
      lastError
    );

    if (onAuthError) {
      onAuthError(authError);
    }

    throw authError;
  };

  const resolvedQuery = useAsyncQuery(enhancedQuery, queryDeps, {
    skipFunctionHash: true,
    cacheKey: `async_agent_${options.agent}_${options.name || "default"}`,
    ttl: options.cacheConfig?.ttl
  });

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

  return useAgent({
    ...restOptions,
    query: validatedQuery
  }) as PartySocket & {
    agent: string;
    name: string;
    setState: (state: State) => void;
    call: ReturnType<typeof useAgent>["call"];
    stub: ReturnType<typeof useAgent>["stub"];
  };
}
