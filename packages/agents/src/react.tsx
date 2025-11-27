import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef, use, useMemo, useEffect, useState } from "react";
import type { Agent, MCPServersState, RPCRequest, RPCResponse } from "./";
import type { StreamOptions } from "./client";
import type { Method, RPCMethod } from "./serializable";
import { MessageType } from "./ai-types";
import type { Task, TaskEvent, TaskStatus } from "./task";

// ============================================================================
// Task Types
// ============================================================================

/**
 * Reactive task reference returned by agent.task()
 * All properties are getters that read from the latest state
 */
export interface TaskRef<TResult = unknown> {
  /** Task ID */
  readonly id: string;
  /** Current status - updates reactively */
  readonly status: TaskStatus;
  /** Result when completed */
  readonly result: TResult | undefined;
  /** Error message when failed */
  readonly error: string | undefined;
  /** Progress 0-100 */
  readonly progress: number | undefined;
  /** Events emitted during execution */
  readonly events: TaskEvent[];
  /** When created */
  readonly createdAt: number | undefined;
  /** When started */
  readonly startedAt: number | undefined;
  /** When completed */
  readonly completedAt: number | undefined;

  // Computed status helpers
  readonly isLoading: boolean;
  readonly isSuccess: boolean;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly isRunning: boolean;
  readonly isCompleted: boolean;
  readonly isAborted: boolean;

  /** Abort the running task */
  abort(): Promise<void>;
}

/**
 * Convert a camelCase string to a kebab-case string
 * @param str The string to convert
 * @returns The kebab-case string
 */
function camelCaseToKebabCase(str: string): string {
  // If string is all uppercase, convert to lowercase
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }

  // Otherwise handle camelCase to kebab-case
  let kebabified = str.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  // Convert any remaining underscores to hyphens and remove trailing -'s
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}

type QueryObject = Record<string, string | null>;

const queryCache = new Map<
  unknown[],
  {
    promise: Promise<QueryObject>;
    refCount: number;
    expiresAt: number;
    cacheTtl?: number;
  }
>();

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

function findCacheEntry(
  targetKey: unknown[]
): Promise<QueryObject> | undefined {
  for (const [existingKey, entry] of queryCache.entries()) {
    if (arraysEqual(existingKey, targetKey)) {
      // Check if entry has expired
      if (Date.now() > entry.expiresAt) {
        queryCache.delete(existingKey);
        return undefined;
      }
      entry.refCount++;
      return entry.promise;
    }
  }
  return undefined;
}

function setCacheEntry(
  key: unknown[],
  value: Promise<QueryObject>,
  cacheTtl?: number
): void {
  // Remove any existing entry with matching members
  for (const [existingKey] of queryCache.entries()) {
    if (arraysEqual(existingKey, key)) {
      queryCache.delete(existingKey);
      break;
    }
  }

  const expiresAt = cacheTtl
    ? Date.now() + cacheTtl
    : Date.now() + 5 * 60 * 1000; // Default 5 minutes
  queryCache.set(key, { promise: value, refCount: 1, expiresAt, cacheTtl });
}

function decrementCacheEntry(targetKey: unknown[]): boolean {
  for (const [existingKey, entry] of queryCache.entries()) {
    if (arraysEqual(existingKey, targetKey)) {
      entry.refCount--;
      if (entry.refCount <= 0) {
        queryCache.delete(existingKey);
      }
      return true;
    }
  }
  return false;
}

function createCacheKey(
  agentNamespace: string,
  name: string | undefined,
  deps: unknown[]
): unknown[] {
  return [agentNamespace, name || "default", ...deps];
}

/**
 * Options for the useAgent hook
 * @template State Type of the Agent's state
 */
export type UseAgentOptions<State = unknown> = Omit<
  Parameters<typeof usePartySocket>[0],
  "party" | "room" | "query"
> & {
  /** Name of the agent to connect to */
  agent: string;
  /** Name of the specific Agent instance */
  name?: string;
  /** Query parameters - can be static object or async function */
  query?: QueryObject | (() => Promise<QueryObject>);
  /** Dependencies for async query caching */
  queryDeps?: unknown[];
  /** Cache TTL in milliseconds for auth tokens/time-sensitive data */
  cacheTtl?: number;
  /** Called when the Agent's state is updated */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  /** Called when MCP server state is updated */
  onMcpUpdate?: (mcpServers: MCPServersState) => void;
};

type AllOptional<T> = T extends [infer A, ...infer R]
  ? undefined extends A
    ? AllOptional<R>
    : false
  : true; // no params means optional by default

type RPCMethods<T> = {
  [K in keyof T as T[K] extends RPCMethod<T[K]> ? K : never]: RPCMethod<T[K]>;
};

type OptionalParametersMethod<T extends RPCMethod> =
  AllOptional<Parameters<T>> extends true ? T : never;

// all methods of the Agent, excluding the ones that are declared in the base Agent class
// biome-ignore lint: suppressions/parse
type AgentMethods<T> = Omit<RPCMethods<T>, keyof Agent<any, any>>;

type OptionalAgentMethods<T> = {
  [K in keyof AgentMethods<T> as AgentMethods<T>[K] extends OptionalParametersMethod<
    AgentMethods<T>[K]
  >
    ? K
    : never]: OptionalParametersMethod<AgentMethods<T>[K]>;
};

type RequiredAgentMethods<T> = Omit<
  AgentMethods<T>,
  keyof OptionalAgentMethods<T>
>;

type AgentPromiseReturnType<T, K extends keyof AgentMethods<T>> =
  // biome-ignore lint: suppressions/parse
  ReturnType<AgentMethods<T>[K]> extends Promise<any>
    ? ReturnType<AgentMethods<T>[K]>
    : Promise<ReturnType<AgentMethods<T>[K]>>;

type OptionalArgsAgentMethodCall<AgentT> = <
  K extends keyof OptionalAgentMethods<AgentT>
>(
  method: K,
  args?: Parameters<OptionalAgentMethods<AgentT>[K]>,
  streamOptions?: StreamOptions
) => AgentPromiseReturnType<AgentT, K>;

type RequiredArgsAgentMethodCall<AgentT> = <
  K extends keyof RequiredAgentMethods<AgentT>
>(
  method: K,
  args: Parameters<RequiredAgentMethods<AgentT>[K]>,
  streamOptions?: StreamOptions
) => AgentPromiseReturnType<AgentT, K>;

type AgentMethodCall<AgentT> = OptionalArgsAgentMethodCall<AgentT> &
  RequiredArgsAgentMethodCall<AgentT>;

type UntypedAgentMethodCall = <T = unknown>(
  method: string,
  args?: unknown[],
  streamOptions?: StreamOptions
) => Promise<T>;

type AgentStub<T> = {
  [K in keyof AgentMethods<T>]: (
    ...args: Parameters<AgentMethods<T>[K]>
  ) => AgentPromiseReturnType<AgentMethods<T>, K>;
};

// we neet to use Method instead of RPCMethod here for retro-compatibility
type UntypedAgentStub = Record<string, Method>;

/**
 * Extended agent type with task support
 */
export type AgentWithTasks<State = unknown> = PartySocket & {
  agent: string;
  name: string;
  setState: (state: State) => void;
  call: UntypedAgentMethodCall;
  stub: UntypedAgentStub;
  /**
   * Start a task and get a reactive TaskRef back.
   * The returned object updates automatically as the task progresses.
   *
   * @example
   * ```tsx
   * const task = await agent.task("analyzeRepo", { repoUrl });
   * // task.status, task.progress, etc. update automatically
   * ```
   */
  task: <TResult = unknown>(
    method: string,
    input: unknown
  ) => Promise<TaskRef<TResult>>;
  /** All active tasks - reactive state */
  tasks: Record<string, Task>;
};

/**
 * React hook for connecting to an Agent
 */
export function useAgent<State = unknown>(
  options: UseAgentOptions<State>
): AgentWithTasks<State>;
export function useAgent<
  AgentT extends {
    get state(): State;
  },
  State
>(
  options: UseAgentOptions<State>
): AgentWithTasks<State> & {
  call: AgentMethodCall<AgentT>;
  stub: AgentStub<AgentT>;
};
export function useAgent<State>(
  options: UseAgentOptions<unknown>
): AgentWithTasks<State> {
  const agentNamespace = camelCaseToKebabCase(options.agent);
  const { query, queryDeps, cacheTtl, ...restOptions } = options;

  // Keep track of pending RPC calls
  const pendingCallsRef = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        stream?: StreamOptions;
      }
    >()
  );

  // Task tracking state - reactive, updates when server sends _tasks
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const setTasksRef = useRef(setTasks);
  setTasksRef.current = setTasks;

  // Handle both sync and async query patterns
  const cacheKey = useMemo(() => {
    const deps = queryDeps || [];
    return createCacheKey(agentNamespace, options.name, deps);
  }, [agentNamespace, options.name, queryDeps]);

  const queryPromise = useMemo(() => {
    if (!query || typeof query !== "function") {
      return null;
    }

    const existingPromise = findCacheEntry(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = query().catch((error) => {
      console.error(
        `[useAgent] Query failed for agent "${options.agent}":`,
        error
      );
      decrementCacheEntry(cacheKey); // Remove failed promise from cache
      throw error; // Re-throw for Suspense error boundary
    });

    setCacheEntry(cacheKey, promise, cacheTtl);

    return promise;
  }, [cacheKey, query, options.agent, cacheTtl]);

  let resolvedQuery: QueryObject | undefined;

  if (query) {
    if (typeof query === "function") {
      // Use React's use() to resolve the promise
      const queryResult = use(queryPromise!);

      // Check for non-primitive values and warn
      if (queryResult) {
        for (const [key, value] of Object.entries(queryResult)) {
          if (
            value !== null &&
            value !== undefined &&
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean"
          ) {
            console.warn(
              `[useAgent] Query parameter "${key}" is an object and will be converted to "[object Object]". ` +
                "Query parameters should be string, number, boolean, or null."
            );
          }
        }
        resolvedQuery = queryResult;
      }
    } else {
      // Sync query - use directly
      resolvedQuery = query;
    }
  }

  // Cleanup cache on unmount
  useEffect(() => {
    return () => {
      if (queryPromise) {
        decrementCacheEntry(cacheKey);
      }
    };
  }, [cacheKey, queryPromise]);

  const agent = usePartySocket({
    party: agentNamespace,
    prefix: "agents",
    room: options.name || "default",
    query: resolvedQuery,
    ...restOptions,
    onMessage: (message) => {
      if (typeof message.data === "string") {
        let parsedMessage: Record<string, unknown>;
        try {
          parsedMessage = JSON.parse(message.data);
        } catch (_error) {
          // silently ignore invalid messages for now
          // TODO: log errors with log levels
          return options.onMessage?.(message);
        }
        if (parsedMessage.type === MessageType.CF_AGENT_STATE) {
          options.onStateUpdate?.(parsedMessage.state as State, "server");
          return;
        }
        // Handle task updates (separate from main state)
        if (parsedMessage.type === "CF_AGENT_TASK_UPDATE") {
          const { taskId, task } = parsedMessage as {
            taskId: string;
            task: Task | null;
          };
          setTasksRef.current((prev) => {
            if (task === null) {
              const { [taskId]: _, ...rest } = prev;
              return rest;
            }
            return { ...prev, [taskId]: task };
          });
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_MCP_SERVERS) {
          options.onMcpUpdate?.(parsedMessage.mcp as MCPServersState);
          return;
        }
        if (parsedMessage.type === MessageType.RPC) {
          const response = parsedMessage as RPCResponse;
          const pending = pendingCallsRef.current.get(response.id);
          if (!pending) return;

          if (!response.success) {
            pending.reject(new Error(response.error));
            pendingCallsRef.current.delete(response.id);
            pending.stream?.onError?.(response.error);
            return;
          }

          // Handle streaming responses
          if ("done" in response) {
            if (response.done) {
              pending.resolve(response.result);
              pendingCallsRef.current.delete(response.id);
              pending.stream?.onDone?.(response.result);
            } else {
              pending.stream?.onChunk?.(response.result);
            }
          } else {
            // Non-streaming response
            pending.resolve(response.result);
            pendingCallsRef.current.delete(response.id);
          }
          return;
        }
      }
      options.onMessage?.(message);
    }
  }) as PartySocket & {
    agent: string;
    name: string;
    setState: (state: State) => void;
    call: UntypedAgentMethodCall;
    stub: UntypedAgentStub;
  };
  // Create the call method
  const call = useCallback(
    <T = unknown,>(
      method: string,
      args: unknown[] = [],
      streamOptions?: StreamOptions
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        pendingCallsRef.current.set(id, {
          reject,
          resolve: resolve as (value: unknown) => void,
          stream: streamOptions
        });

        const request: RPCRequest = {
          args,
          id,
          method,
          type: MessageType.RPC
        };

        agent.send(JSON.stringify(request));
      });
    },
    [agent]
  );

  agent.setState = (state: State) => {
    agent.send(JSON.stringify({ state, type: MessageType.CF_AGENT_STATE }));
    options.onStateUpdate?.(state, "client");
  };

  agent.call = call;
  agent.agent = agentNamespace;
  agent.name = options.name || "default";
  // biome-ignore lint: suppressions/parse
  agent.stub = new Proxy<any>(
    {},
    {
      get: (_target, method) => {
        return (...args: unknown[]) => {
          return call(method as string, args);
        };
      }
    }
  );

  // warn if agent isn't in lowercase
  if (agent.agent !== agent.agent.toLowerCase()) {
    console.warn(
      `Agent name: ${agent.agent} should probably be in lowercase. Received: ${agent.agent}`
    );
  }

  // Create task method - starts a task and returns a reactive TaskRef
  const taskMethod = useCallback(
    async <TResult = unknown,>(
      method: string,
      input: unknown
    ): Promise<TaskRef<TResult>> => {
      // Call the task method - returns { id, status }
      const handle = (await call(method, [input])) as {
        id: string;
        status: TaskStatus;
      };
      const taskId = handle.id;

      // Helper to get current status
      const getStatus = (): TaskStatus =>
        (tasksRef.current[taskId]?.status || handle.status) as TaskStatus;

      // Return a TaskRef with getters that read from the latest state
      // When tasks state updates, the component re-renders, and getters return new values
      const ref: TaskRef<TResult> = {
        get id() {
          return taskId;
        },
        get status() {
          return getStatus();
        },
        get result() {
          return tasksRef.current[taskId]?.result as TResult | undefined;
        },
        get error() {
          return tasksRef.current[taskId]?.error;
        },
        get progress() {
          return tasksRef.current[taskId]?.progress;
        },
        get events() {
          return tasksRef.current[taskId]?.events || [];
        },
        get createdAt() {
          return tasksRef.current[taskId]?.createdAt;
        },
        get startedAt() {
          return tasksRef.current[taskId]?.startedAt;
        },
        get completedAt() {
          return tasksRef.current[taskId]?.completedAt;
        },
        get isLoading() {
          const s = getStatus();
          return s === "pending" || s === "running";
        },
        get isSuccess() {
          return getStatus() === "completed";
        },
        get isError() {
          const s = getStatus();
          return s === "failed" || s === "aborted";
        },
        get isPending() {
          return getStatus() === "pending";
        },
        get isRunning() {
          return getStatus() === "running";
        },
        get isCompleted() {
          return getStatus() === "completed";
        },
        get isAborted() {
          return getStatus() === "aborted";
        },
        abort: async () => {
          await call("abortTask", [taskId]);
        }
      };
      return ref;
    },
    [call]
  );

  // Add task support to agent
  (agent as AgentWithTasks<State>).task = taskMethod;
  (agent as AgentWithTasks<State>).tasks = tasks;

  return agent as AgentWithTasks<State>;
}

// ============================================================================
// Task Hook
// ============================================================================

/**
 * Reactive task state returned by useTask
 */
export interface UseTaskState<TResult = unknown> {
  /** Task ID */
  id: string;
  /** Current task status */
  status: TaskStatus;
  /** Task result (when completed) */
  result?: TResult;
  /** Error message (when failed) */
  error?: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Events emitted during task execution */
  events: TaskEvent[];
  /** When the task was created */
  createdAt?: number;
  /** When execution started */
  startedAt?: number;
  /** When execution completed */
  completedAt?: number;

  // Computed properties
  /** Whether the task is currently loading (pending or running) */
  isLoading: boolean;
  /** Whether the task completed successfully */
  isSuccess: boolean;
  /** Whether the task failed or was aborted */
  isError: boolean;
  /** Whether the task is pending */
  isPending: boolean;
  /** Whether the task is running */
  isRunning: boolean;
  /** Whether the task is completed */
  isCompleted: boolean;
  /** Whether the task is aborted */
  isAborted: boolean;

  // Actions
  /** Abort the task */
  abort: () => Promise<void>;
  /** Refresh the task state */
  refresh: () => Promise<void>;
}

/**
 * Options for useTask hook
 */
export interface UseTaskOptions {
  /** Callback when task status changes */
  onStatusChange?: (status: TaskStatus) => void;
  /** Callback when task completes */
  onComplete?: (result: unknown) => void;
  /** Callback when task fails */
  onError?: (error: string) => void;
  /** Callback when a task event is emitted */
  onEvent?: (event: TaskEvent) => void;
}

/**
 * React hook for tracking a task's state in real-time.
 *
 * Uses the existing state sync mechanism - tasks are stored in `state._tasks`
 * and automatically broadcast to clients via CF_AGENT_STATE messages.
 *
 * @param agent - The agent connection from useAgent()
 * @param taskId - The task ID to track
 * @param options - Optional callbacks
 * @returns Reactive task state with actions
 *
 * @example
 * ```tsx
 * function TaskView({ taskId }: { taskId: string }) {
 *   const agent = useAgent({ agent: "task-runner" });
 *   const task = useTask(agent, taskId);
 *
 *   if (task.isPending) return <Spinner />;
 *   if (task.isError) return <Error message={task.error} />;
 *
 *   return (
 *     <div>
 *       <ProgressBar value={task.progress} />
 *       {task.events.map(e => <div key={e.id}>{e.type}</div>)}
 *       {task.isRunning && <button onClick={task.abort}>Abort</button>}
 *       {task.isSuccess && <Result data={task.result} />}
 *     </div>
 *   );
 * }
 * ```
 */
export function useTask<TResult = unknown>(
  agent: PartySocket & {
    call: (method: string, args?: unknown[]) => Promise<unknown>;
  },
  taskId: string,
  options: UseTaskOptions = {}
): UseTaskState<TResult> {
  const [task, setTask] = useState<Task<TResult> | null>(null);
  const prevStatusRef = useRef<TaskStatus | null>(null);
  const prevEventsLengthRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Fetch initial task state via RPC
  const fetchTask = useCallback(async () => {
    try {
      const result = (await agent.call("getTask", [
        taskId
      ])) as Task<TResult> | null;
      if (result) {
        setTask(result);
      }
    } catch (err) {
      console.error("[useTask] Failed to fetch task:", err);
    }
  }, [agent, taskId]);

  // Fetch on mount
  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  // Listen for state updates - tasks are synced via existing state mechanism
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data);

        // Reuse existing state sync - tasks are in state._tasks
        if (message.type === MessageType.CF_AGENT_STATE) {
          const tasks = message.state?._tasks as
            | Record<string, Task<TResult>>
            | undefined;
          const updatedTask = tasks?.[taskId];
          if (updatedTask) {
            setTask(updatedTask);
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    };

    agent.addEventListener("message", handleMessage);
    return () => agent.removeEventListener("message", handleMessage);
  }, [agent, taskId]);

  // Call callbacks when status changes
  useEffect(() => {
    if (!task) return;

    // Status change callback
    if (task.status !== prevStatusRef.current) {
      const prevStatus = prevStatusRef.current;
      prevStatusRef.current = task.status;

      if (prevStatus !== null) {
        optionsRef.current.onStatusChange?.(task.status);

        if (task.status === "completed") {
          optionsRef.current.onComplete?.(task.result);
        }

        if (task.status === "failed" || task.status === "aborted") {
          optionsRef.current.onError?.(task.error || "Task failed");
        }
      }
    }

    // Event callback for new events
    if (task.events.length > prevEventsLengthRef.current) {
      const newEvents = task.events.slice(prevEventsLengthRef.current);
      for (const event of newEvents) {
        optionsRef.current.onEvent?.(event);
      }
      prevEventsLengthRef.current = task.events.length;
    }
  }, [task]);

  // Abort action
  const abort = useCallback(async () => {
    try {
      await agent.call("abortTask", [taskId]);
    } catch (err) {
      console.error("[useTask] Failed to abort task:", err);
    }
  }, [agent, taskId]);

  // Refresh action
  const refresh = useCallback(async () => {
    await fetchTask();
  }, [fetchTask]);

  // Default values for when task is not yet loaded
  const status = task?.status ?? "pending";
  const events = task?.events ?? [];

  return {
    id: taskId,
    status,
    result: task?.result,
    error: task?.error,
    progress: task?.progress,
    events,
    createdAt: task?.createdAt,
    startedAt: task?.startedAt,
    completedAt: task?.completedAt,
    isLoading: status === "pending" || status === "running",
    isSuccess: status === "completed",
    isError: status === "failed" || status === "aborted",
    isPending: status === "pending",
    isRunning: status === "running",
    isCompleted: status === "completed",
    isAborted: status === "aborted",
    abort,
    refresh
  };
}
