import {
  type PartyFetchOptions,
  PartySocket,
  type PartySocketOptions
} from "partysocket";
import type { RPCRequest, RPCResponse } from "./";
import type {
  SerializableReturnValue,
  SerializableValue
} from "./serializable";
import { MessageType } from "./types";

/**
 * Options for creating an AgentClient
 */
export type AgentClientOptions<State = unknown> = Omit<
  PartySocketOptions,
  "party" | "room"
> & {
  /** Name of the agent to connect to (ignored if basePath is set) */
  agent: string;
  /** Name of the specific Agent instance (ignored if basePath is set) */
  name?: string;
  /**
   * Full URL path - bypasses agent/name URL construction.
   * When set, the client connects to this path directly.
   * Server must handle routing manually (e.g., with getAgentByName + fetch).
   * @example
   * // Client connects to /user, server routes based on session
   * useAgent({ agent: "UserAgent", basePath: "user" })
   */
  basePath?: string;
  /** Called when the Agent's state is updated */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  /** Called when a state update fails (e.g., connection is readonly) */
  onStateUpdateError?: (error: string) => void;
  /**
   * Called when the server sends the agent's identity on connect.
   * Useful when using basePath, as the actual instance name is determined server-side.
   * @param name The actual agent instance name
   * @param agent The agent class name (kebab-case)
   */
  onIdentity?: (name: string, agent: string) => void;
  /**
   * Called when identity changes on reconnect (different instance than before).
   * If not provided and identity changes, a warning will be logged.
   * @param oldName Previous instance name
   * @param newName New instance name
   * @param oldAgent Previous agent class name
   * @param newAgent New agent class name
   */
  onIdentityChange?: (
    oldName: string,
    newName: string,
    oldAgent: string,
    newAgent: string
  ) => void;
  /**
   * Additional path to append to the URL.
   * Works with both standard routing and basePath.
   * @example
   * // With basePath: /user/settings
   * { basePath: "user", path: "settings" }
   * // Standard: /agents/my-agent/room/settings
   * { agent: "MyAgent", name: "room", path: "settings" }
   */
  path?: string;
};

/**
 * Options for streaming RPC calls
 */
export type StreamOptions = {
  /** Called when a chunk of data is received */
  onChunk?: (chunk: unknown) => void;
  /** Called when the stream ends */
  onDone?: (finalChunk: unknown) => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
};

/**
 * Options for RPC calls
 */
export type CallOptions = {
  /** Timeout in milliseconds. If the call doesn't complete within this time, it will be rejected. */
  timeout?: number;
  /** Streaming options for handling streaming responses */
  stream?: StreamOptions;
};

/**
 * Options for the agentFetch function
 */
export type AgentClientFetchOptions = Omit<
  PartyFetchOptions,
  "party" | "room"
> & {
  /** Name of the agent to connect to (ignored if basePath is set) */
  agent: string;
  /** Name of the specific Agent instance (ignored if basePath is set) */
  name?: string;
  /**
   * Full URL path - bypasses agent/name URL construction.
   * When set, the request is made to this path directly.
   */
  basePath?: string;
};

import { camelCaseToKebabCase } from "./utils";

/**
 * WebSocket client for connecting to an Agent
 */
export class AgentClient<State = unknown> extends PartySocket {
  /**
   * @deprecated Use agentFetch instead
   */
  static fetch(_opts: PartyFetchOptions): Promise<Response> {
    throw new Error(
      "AgentClient.fetch is not implemented, use agentFetch instead"
    );
  }
  agent: string;
  name: string;

  /**
   * Whether the client has received identity from the server.
   * Becomes true after the first identity message is received.
   * Resets to false on connection close.
   */
  identified = false;

  /**
   * Promise that resolves when identity has been received from the server.
   * Useful for waiting before making calls that depend on knowing the instance.
   * Resets on connection close so it can be awaited again after reconnect.
   */
  get ready(): Promise<void> {
    return this._readyPromise;
  }

  private options: AgentClientOptions<State>;
  private _pendingCalls = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      stream?: StreamOptions;
      type?: unknown;
    }
  >();
  private _readyPromise!: Promise<void>;
  private _resolveReady!: () => void;
  private _previousName: string | null = null;
  private _previousAgent: string | null = null;

  private _resetReady() {
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
  }

  constructor(options: AgentClientOptions<State>) {
    const agentNamespace = camelCaseToKebabCase(options.agent);

    // If basePath is provided, use it directly; otherwise construct from agent/name.
    // WORKAROUND: When using basePath, we still set `room` and `party` because
    // PartySocket.reconnect() requires `room` to be set, even though basePath bypasses
    // the room-based URL construction. This should be removed once partysocket is fixed
    // to skip the `room` check when `basePath` is provided.
    const socketOptions = options.basePath
      ? {
          basePath: options.basePath,
          party: agentNamespace,
          room: options.name || "default",
          path: options.path,
          ...options
        }
      : {
          party: agentNamespace,
          prefix: "agents",
          room: options.name || "default",
          path: options.path,
          ...options
        };

    super(socketOptions);
    this.agent = agentNamespace;
    this.name = options.name || "default";
    this.options = options;

    // Initialize ready promise
    this._resetReady();

    this.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        let parsedMessage: Record<string, unknown>;
        try {
          parsedMessage = JSON.parse(event.data);
        } catch (_error) {
          // silently ignore invalid messages for now
          // TODO: log errors with log levels
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_IDENTITY) {
          const oldName = this._previousName;
          const oldAgent = this._previousAgent;
          const newName = parsedMessage.name as string;
          const newAgent = parsedMessage.agent as string;

          // Resolve ready/identified
          this.identified = true;
          this._resolveReady();

          // Detect identity change on reconnect
          if (
            oldName !== null &&
            oldAgent !== null &&
            (oldName !== newName || oldAgent !== newAgent)
          ) {
            if (this.options.onIdentityChange) {
              this.options.onIdentityChange(
                oldName,
                newName,
                oldAgent,
                newAgent
              );
            } else {
              const agentChanged = oldAgent !== newAgent;
              const nameChanged = oldName !== newName;
              let changeDescription = "";
              if (agentChanged && nameChanged) {
                changeDescription = `agent "${oldAgent}" → "${newAgent}", instance "${oldName}" → "${newName}"`;
              } else if (agentChanged) {
                changeDescription = `agent "${oldAgent}" → "${newAgent}"`;
              } else {
                changeDescription = `instance "${oldName}" → "${newName}"`;
              }
              console.warn(
                `[agents] Identity changed on reconnect: ${changeDescription}. ` +
                  "This can happen with server-side routing (e.g., basePath with getAgentByName) " +
                  "where the instance is determined by auth/session. " +
                  "Provide onIdentityChange callback to handle this explicitly, " +
                  "or ignore if this is expected for your routing pattern."
              );
            }
          }

          // Always update from server identity (server is authoritative)
          this._previousName = newName;
          this._previousAgent = newAgent;
          this.name = newName;
          this.agent = newAgent;

          // Call onIdentity callback
          this.options.onIdentity?.(newName, newAgent);
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_STATE) {
          this.options.onStateUpdate?.(parsedMessage.state as State, "server");
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_STATE_ERROR) {
          this.options.onStateUpdateError?.(parsedMessage.error as string);
          return;
        }
        if (parsedMessage.type === MessageType.RPC) {
          const response = parsedMessage as RPCResponse;
          const pending = this._pendingCalls.get(response.id);
          if (!pending) return;

          if (!response.success) {
            pending.reject(new Error(response.error));
            this._pendingCalls.delete(response.id);
            pending.stream?.onError?.(response.error);
            return;
          }

          // Handle streaming responses
          if ("done" in response) {
            if (response.done) {
              pending.resolve(response.result);
              this._pendingCalls.delete(response.id);
              pending.stream?.onDone?.(response.result);
            } else {
              pending.stream?.onChunk?.(response.result);
            }
          } else {
            // Non-streaming response
            pending.resolve(response.result);
            this._pendingCalls.delete(response.id);
          }
        }
      }
    });

    // Clean up pending calls and reset ready state when connection closes
    this.addEventListener("close", () => {
      // Reset ready state for next connection
      this.identified = false;
      this._resetReady();

      // Reject any remaining pending calls (e.g., from unexpected disconnect)
      this._rejectPendingCalls("Connection closed");
    });
  }

  /**
   * Reject all pending RPC calls with the given reason.
   */
  private _rejectPendingCalls(reason: string) {
    const error = new Error(reason);
    for (const pending of this._pendingCalls.values()) {
      pending.reject(error);
      pending.stream?.onError?.(reason);
    }
    this._pendingCalls.clear();
  }

  setState(state: State) {
    this.send(JSON.stringify({ state, type: MessageType.CF_AGENT_STATE }));
    this.options.onStateUpdate?.(state, "client");
  }

  /**
   * Close the connection and immediately reject all pending RPC calls.
   * This provides immediate feedback on intentional close rather than
   * waiting for the WebSocket close handshake to complete.
   *
   * Note: Any calls made after `close()` will be rejected when the
   * underlying WebSocket close event fires.
   */
  close(code?: number, reason?: string) {
    // Immediately reject all pending calls on intentional close
    this._rejectPendingCalls("Connection closed");

    // Then close the underlying socket
    super.close(code, reason);
  }

  /**
   * Call a method on the Agent
   * @param method Name of the method to call
   * @param args Arguments to pass to the method
   * @param options Options for the call (timeout, streaming) or legacy StreamOptions
   * @returns Promise that resolves with the method's return value
   */
  call<T extends SerializableReturnValue>(
    method: string,
    args?: SerializableValue[],
    options?: CallOptions | StreamOptions
  ): Promise<T>;
  call<T = unknown>(
    method: string,
    args?: unknown[],
    options?: CallOptions | StreamOptions
  ): Promise<T>;
  async call<T>(
    method: string,
    args: unknown[] = [],
    options?: CallOptions | StreamOptions
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      // Detect legacy format: { onChunk?, onDone?, onError? } vs new format: { timeout?, stream? }
      const isLegacyFormat =
        options &&
        ("onChunk" in options || "onDone" in options || "onError" in options);
      const streamOptions = isLegacyFormat
        ? (options as StreamOptions)
        : (options as CallOptions | undefined)?.stream;
      const timeout = isLegacyFormat
        ? undefined
        : (options as CallOptions | undefined)?.timeout;

      // Set up timeout if specified
      if (timeout) {
        timeoutId = setTimeout(() => {
          const pending = this._pendingCalls.get(id);
          this._pendingCalls.delete(id);
          const errorMessage = `RPC call to ${method} timed out after ${timeout}ms`;
          // Call stream onError callback if present (for streaming calls)
          pending?.stream?.onError?.(errorMessage);
          reject(new Error(errorMessage));
        }, timeout);
      }

      this._pendingCalls.set(id, {
        reject: (e: Error) => {
          if (timeoutId) clearTimeout(timeoutId);
          reject(e);
        },
        resolve: (value: unknown) => {
          if (timeoutId) clearTimeout(timeoutId);
          resolve(value as T);
        },
        stream: streamOptions,
        type: null as T
      });

      const request: RPCRequest = {
        args,
        id,
        method,
        type: MessageType.RPC
      };

      this.send(JSON.stringify(request));
    });
  }
}

/**
 * Make an HTTP request to an Agent
 * @param opts Connection options
 * @param init Request initialization options
 * @returns Promise resolving to a Response
 */
export function agentFetch(opts: AgentClientFetchOptions, init?: RequestInit) {
  const agentNamespace = camelCaseToKebabCase(opts.agent);

  // If basePath is provided, use it directly; otherwise construct from agent/name
  // When basePath is set, room/party aren't used by PartySocket (basePath replaces the URL)
  if (opts.basePath) {
    return PartySocket.fetch(
      { basePath: opts.basePath, ...opts } as unknown as PartyFetchOptions,
      init
    );
  }

  return PartySocket.fetch(
    {
      party: agentNamespace,
      prefix: "agents",
      room: opts.name || "default",
      ...opts
    },
    init
  );
}
